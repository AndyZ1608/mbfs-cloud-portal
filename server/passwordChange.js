import { osFetch, OSError } from './openstack.js';

export const PASSWORD_CHANGE_USERNAME = 'ubuntu';

const REASONS = Object.freeze({
  invalid_instance_state: 'VM cần ở trạng thái ACTIVE để đổi mật khẩu.',
  unsupported_instance_source: 'Không xác định được metadata image để kiểm tra Change Password.',
  image_not_found: 'Không tìm thấy image gốc của VM.',
  image_metadata_unavailable: 'Không xác định được metadata image để kiểm tra Change Password.',
  unsupported_distro: 'Chỉ hỗ trợ image Ubuntu.',
  guest_agent_not_enabled: 'QEMU Guest Agent chưa được bật trên image.',
  admin_user_not_configured: 'Image chưa cấu hình os_admin_user=ubuntu.',
  permission_denied: 'Cần role member hoặc admin trong project hiện tại.',
});

const denied = (reason) => ({ allowed: false, username: null, reason, message: REASONS[reason] });
const allowed = () => ({ allowed: true, username: PASSWORD_CHANGE_USERNAME, reason: null, message: null });

export function hasPasswordChangeRole(session) {
  return session?.roles?.some((role) => role === 'member' || role === 'admin') === true;
}

export function isProjectServer(server, session) {
  const projectId = server?.tenant_id || server?.project_id;
  return typeof projectId === 'string' && projectId.length > 0 && projectId === session?.project?.id;
}

export function parseOpenStackBoolean(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['yes', 'true', '1'].includes(value.trim().toLowerCase());
  return false;
}

export function evaluatePasswordChangeEligibility(instance, image) {
  if (instance?.status !== 'ACTIVE' || instance?.['OS-EXT-STS:task_state']) return denied('invalid_instance_state');
  if (typeof instance?.image?.id !== 'string' || !instance.image.id) return denied('unsupported_instance_source');
  if (!image || typeof image !== 'object') return denied('image_metadata_unavailable');
  if (String(image.os_distro || '').trim().toLowerCase() !== 'ubuntu') return denied('unsupported_distro');
  if (!parseOpenStackBoolean(image.hw_qemu_guest_agent)) return denied('guest_agent_not_enabled');
  if (image.os_admin_user !== PASSWORD_CHANGE_USERNAME) return denied('admin_user_not_configured');
  return allowed();
}

async function imageFor(session, imageId, fetchOpenStack) {
  try {
    const image = await fetchOpenStack(session, 'image', `/v2/images/${encodeURIComponent(imageId)}`);
    return { image };
  } catch (error) {
    if (error?.status === 401) throw new OSError(401, 'Phiên OpenStack đã hết hạn.', 'authentication_required');
    return { reason: error?.status === 404 ? 'image_not_found' : 'image_metadata_unavailable' };
  }
}

// One Glance request per distinct image, with bounded concurrency for a large VM list.
export async function listPasswordChangeEligibility(session, fetchOpenStack = osFetch) {
  const data = await fetchOpenStack(session, 'compute', '/servers/detail');
  const servers = (data?.servers || []).filter((server) => isProjectServer(server, session));
  const result = {};
  if (!hasPasswordChangeRole(session)) {
    for (const server of servers) result[server.id] = denied('permission_denied');
    return result;
  }

  const ids = [...new Set(servers.filter((server) =>
    server.status === 'ACTIVE' && !server['OS-EXT-STS:task_state'] && server.image?.id
  ).map((server) => server.image.id))];
  const images = new Map();
  for (let index = 0; index < ids.length; index += 4) {
    await Promise.all(ids.slice(index, index + 4).map(async (id) => {
      images.set(id, await imageFor(session, id, fetchOpenStack));
    }));
  }
  for (const server of servers) {
    const record = images.get(server.image?.id);
    result[server.id] = record?.reason
      ? denied(record.reason)
      : evaluatePasswordChangeEligibility(server, record?.image);
  }
  return result;
}

function safeNovaError(error) {
  if (error?.status === 401) return new OSError(401, 'Phiên OpenStack đã hết hạn.', 'authentication_required');
  if (error?.status === 403) return new OSError(403, 'Nova từ chối quyền đổi mật khẩu VM.', 'permission_denied');
  if (error?.status === 404) return new OSError(404, 'Không tìm thấy VM.', 'server_not_found');
  if (error?.status === 400) return new OSError(400, 'Nova từ chối mật khẩu mới. Kiểm tra yêu cầu mật khẩu của cloud.', 'invalid_password');
  if (error?.status === 409) return new OSError(409, 'Trạng thái VM đã thay đổi. Tải lại VM rồi thử lại.', 'invalid_instance_state');
  if (error?.status === 501 || /(?:guest[ -]?agent|qemu agent|agent.unresponsive|agent.not.responding)/i.test(error?.message || '')) {
    return new OSError(502, 'Không thể đổi mật khẩu vì QEMU Guest Agent trong VM không phản hồi hoặc không hỗ trợ.', 'guest_agent_unavailable');
  }
  if (error?.code === 'provider_timeout' || error?.code === 'provider_unavailable') return error;
  return new OSError(502, 'Nova không thể xử lý yêu cầu đổi mật khẩu VM.', 'provider_failure');
}

export async function changeInstancePassword(session, instanceId, password, fetchOpenStack = osFetch) {
  if (!hasPasswordChangeRole(session)) throw new OSError(403, REASONS.permission_denied, 'permission_denied');
  if (typeof password !== 'string' || password.length === 0) throw new OSError(400, 'Mật khẩu mới không được trống.', 'invalid_password');

  let server;
  try {
    server = (await fetchOpenStack(session, 'compute', `/servers/${encodeURIComponent(instanceId)}`))?.server;
  } catch (error) {
    if (error?.status === 404) throw new OSError(404, 'Không tìm thấy VM trong project hiện tại.', 'server_not_found');
    throw safeNovaError(error);
  }
  if (!isProjectServer(server, session) || server.id !== instanceId) {
    throw new OSError(404, 'Không tìm thấy VM trong project hiện tại.', 'server_not_found');
  }
  let result = evaluatePasswordChangeEligibility(server);
  if (result.reason !== 'invalid_instance_state' && result.reason !== 'unsupported_instance_source') {
    const record = await imageFor(session, server.image.id, fetchOpenStack);
    result = record.reason ? denied(record.reason) : evaluatePasswordChangeEligibility(server, record.image);
  }
  if (!result.allowed) throw new OSError(409, result.message, result.reason);

  try {
    await fetchOpenStack(session, 'compute', `/servers/${encodeURIComponent(instanceId)}/action`, {
      method: 'POST', body: { changePassword: { adminPass: password } },
    });
  } catch (error) {
    throw safeNovaError(error);
  }
  // Nova responds 202 Accepted: the guest-agent operation may still fail asynchronously.
  return { accepted: true, username: PASSWORD_CHANGE_USERNAME, instanceName: server.name };
}
