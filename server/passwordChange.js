import { osFetch, OSError } from './openstack.js';

export function hasPasswordChangeRole(session) {
  return session?.roles?.some((role) => role === 'member' || role === 'admin') === true;
}

export function isProjectServer(server, session) {
  const projectId = server?.tenant_id || server?.project_id;
  return typeof projectId === 'string' && projectId.length > 0 && projectId === session?.project?.id;
}

// Provider messages are not returned verbatim: they can contain the submitted password.
function publicNovaError(status, message, code) {
  const error = new OSError(status, message, code);
  error.expose = true; // Only these fixed, password-free messages reach the browser.
  return error;
}

function safeNovaError(error) {
  if (error?.status === 401) return publicNovaError(401, 'Phiên OpenStack đã hết hạn.', 'authentication_required');
  if (error?.status === 403) return publicNovaError(403, 'Nova từ chối quyền đổi mật khẩu VM.', 'permission_denied');
  if (error?.status === 404) return publicNovaError(404, 'Không tìm thấy VM trong project hiện tại.', 'server_not_found');
  if (/(?:guest[ -]?agent|qemu agent|agent.unresponsive|agent.not.responding)/i.test(error?.message || '')) {
    return publicNovaError(502, 'QEMU Guest Agent trong VM không phản hồi hoặc không hỗ trợ đổi mật khẩu.', 'guest_agent_unavailable');
  }
  if (error?.status === 400) return publicNovaError(400, 'Nova từ chối mật khẩu mới. Kiểm tra yêu cầu mật khẩu của cloud.', 'invalid_password');
  if (error?.status === 409) return publicNovaError(409, 'Nova không thể đổi mật khẩu ở trạng thái VM hiện tại.', 'invalid_instance_state');
  if (error?.status === 501) return publicNovaError(501, 'Nova không hỗ trợ thao tác đổi mật khẩu cho VM này.', 'unsupported_operation');
  if (error?.code === 'provider_timeout') return publicNovaError(504, 'Hết thời gian chờ phản hồi từ Nova.', 'provider_timeout');
  if (error?.code === 'provider_unavailable') return publicNovaError(502, 'Không thể kết nối tới Nova.', 'provider_unavailable');
  return publicNovaError(502, 'Nova không thể xử lý yêu cầu đổi mật khẩu VM.', 'provider_failure');
}

export async function changeInstancePassword(session, instanceId, password, fetchOpenStack = osFetch) {
  if (!hasPasswordChangeRole(session)) throw new OSError(403, 'Cần role member hoặc admin trong project hiện tại.', 'permission_denied');
  if (typeof password !== 'string' || password.length === 0) throw new OSError(400, 'Mật khẩu mới không được trống.', 'invalid_password');

  let server;
  try {
    server = (await fetchOpenStack(session, 'compute', `/servers/${encodeURIComponent(instanceId)}`))?.server;
  } catch (error) {
    throw safeNovaError(error);
  }
  if (!isProjectServer(server, session) || server.id !== instanceId) {
    throw new OSError(404, 'Không tìm thấy VM trong project hiện tại.', 'server_not_found');
  }

  try {
    await fetchOpenStack(session, 'compute', `/servers/${encodeURIComponent(instanceId)}/action`, {
      method: 'POST', body: { changePassword: { adminPass: password } },
    });
  } catch (error) {
    throw safeNovaError(error);
  }
  // Nova responds 202 Accepted; guest completion is asynchronous.
  return { success: true, instanceName: server.name };
}
