import { isIP } from 'node:net';
import { OSError, osFetch } from './openstack.js';
import { currentProjectId, fetchUsableNetwork, fetchUsableSubnet, owned, projectQuery } from './projectScope.js';

const invalid = (code, message) => new OSError(400, message, code);

function authorizationError(error) {
  if (error?.status === 401) return new OSError(401, 'Phiên OpenStack đã hết hạn.', 'authentication_required');
  if (error?.status === 403) return new OSError(403, 'OpenStack từ chối quyền thao tác.', 'permission_denied');
  return null;
}

function ipv4Number(value) {
  if (isIP(value) !== 4) return null;
  return value.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
}

function ipv6Number(value) {
  if (isIP(value) !== 6) return null;
  let normalized = value.toLowerCase();
  if (normalized.includes('.')) {
    const tail = normalized.slice(normalized.lastIndexOf(':') + 1);
    const number = ipv4Number(tail);
    normalized = `${normalized.slice(0, normalized.lastIndexOf(':') + 1)}${Math.floor(number / 65536).toString(16)}:${(number % 65536).toString(16)}`;
  }
  const [left, right] = normalized.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const groups = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  return groups.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part || '0', 16)), 0n);
}

export function validateFixedIp(ip, subnet) {
  if (!ip) return;
  const [base, bits, extra] = String(subnet.cidr || '').split('/');
  const version = isIP(ip);
  const baseVersion = isIP(base);
  const width = version === 4 ? 32 : 128;
  const prefix = /^\d+$/.test(bits || '') ? Number(bits) : -1;
  if (!version || version !== baseVersion || extra !== undefined || prefix < 0 || prefix > width) {
    throw invalid('interface_invalid_ip', 'Địa chỉ IP không hợp lệ cho subnet đã chọn.');
  }
  const address = version === 4 ? BigInt(ipv4Number(ip)) : ipv6Number(ip);
  const network = version === 4 ? BigInt(ipv4Number(base)) : ipv6Number(base);
  const hostBits = BigInt(width - prefix);
  if ((address >> hostBits) !== (network >> hostBits)) {
    throw invalid('interface_invalid_ip', 'Địa chỉ IP không thuộc subnet đã chọn.');
  }
  const host = address & ((1n << hostBits) - 1n);
  if (version === 4 && prefix <= 30 && (host === 0n || host === (1n << hostBits) - 1n)) {
    throw invalid('interface_invalid_ip', 'Không thể dùng địa chỉ network hoặc broadcast.');
  }
  if (ip === subnet.gateway_ip) throw invalid('interface_invalid_ip', 'Không thể dùng địa chỉ gateway.');
}

export function normalizeInterfaces(input) {
  if (!Array.isArray(input) || !input.length) throw invalid('interface_required', 'Cần ít nhất một network interface.');
  const seenIps = new Set();
  return input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.network_id !== 'string' || !item.network_id.trim()
      || typeof item.subnet_id !== 'string' || !item.subnet_id.trim()
      || (item.ip_address != null && typeof item.ip_address !== 'string')) {
      throw invalid('interface_required', 'Chọn Network và Subnet cho mỗi interface.');
    }
    const spec = {
      network_id: item.network_id.trim(), subnet_id: item.subnet_id.trim(),
      ip_address: item.ip_address?.trim() || null,
    };
    if (spec.ip_address) {
      if (seenIps.has(spec.ip_address)) throw invalid('interface_duplicate_ip', 'Địa chỉ IP bị trùng giữa các interface.');
      seenIps.add(spec.ip_address);
    }
    return spec;
  });
}

export async function prepareInterfaces(session, input, { request = osFetch, usableNetwork = fetchUsableNetwork, usableSubnet = fetchUsableSubnet } = {}) {
  const specs = normalizeInterfaces(input);
  const projectId = currentProjectId(session);
  let groups;
  try {
    groups = owned((await request(session, 'network', projectQuery(session, '/v2.0/security-groups'))).security_groups, session);
  } catch (error) {
    const auth = authorizationError(error);
    if (auth) throw auth;
    throw new OSError(502, 'Không thể kiểm tra Security Group mặc định của project.', 'interface_default_sg_failed');
  }
  const defaultGroup = groups.find((group) => group.name === 'default');
  if (!defaultGroup?.id) throw new OSError(404, 'Không tìm thấy Security Group mặc định của project.', 'interface_default_sg_missing');
  for (const spec of specs) {
    const network = await usableNetwork(session, spec.network_id);
    const subnet = await usableSubnet(session, spec.subnet_id);
    if (subnet.network_id !== network.id || !network.subnets?.includes(subnet.id)) {
      throw invalid('interface_subnet_mismatch', 'Subnet không thuộc Network đã chọn.');
    }
    validateFixedIp(spec.ip_address, subnet);
  }
  return { specs, projectId, defaultGroupId: defaultGroup.id };
}

function portError(error) {
  const auth = authorizationError(error);
  if (auth) return auth;
  if (/already\s*(?:allocated|in use)|ipaddress(?:inuse|alreadyallocated)|duplicate.*ip/i.test(error?.message || '')) {
    return new OSError(409, 'Địa chỉ IP đã được sử dụng.', 'interface_ip_in_use');
  }
  const status = error?.status >= 400 && error.status < 500 ? error.status : 502;
  return new OSError(status, 'Không thể tạo network interface.', 'interface_port_failed');
}

export async function createInterfacePort(session, prepared, spec, name, index, request = osFetch) {
  const fixedIp = { subnet_id: spec.subnet_id };
  if (spec.ip_address) fixedIp.ip_address = spec.ip_address;
  try {
    const result = await request(session, 'network', '/v2.0/ports', {
      method: 'POST', body: { port: {
        project_id: prepared.projectId, name: `${name}-nic${index}`,
        network_id: spec.network_id, fixed_ips: [fixedIp],
        security_groups: [prepared.defaultGroupId],
      } },
    });
    if (!result?.port?.id) {
      console.error(`[compute] Port create response missing ID project=${prepared.projectId} network=${spec.network_id} subnet=${spec.subnet_id}`);
      throw new OSError(502, 'Không rõ trạng thái tạo port; cần kiểm tra Neutron trước khi thử lại.', 'interface_partial_failure');
    }
    return result.port;
  } catch (error) {
    if (error?.code === 'interface_partial_failure') throw error;
    if (['provider_timeout', 'provider_unavailable'].includes(error?.code)) {
      console.error(`[compute] Port create outcome unknown project=${prepared.projectId} network=${spec.network_id} subnet=${spec.subnet_id}`);
      throw new OSError(502, 'Không rõ trạng thái tạo port; cần kiểm tra Neutron trước khi thử lại.', 'interface_partial_failure');
    }
    throw portError(error);
  }
}

export async function rollbackInterfacePorts(session, ports, request = osFetch) {
  const remaining = [];
  for (const port of [...ports].reverse()) {
    try { await request(session, 'network', `/v2.0/ports/${encodeURIComponent(port.id)}`, { method: 'DELETE' }); }
    catch (error) {
      remaining.push(port.id);
      console.error(`[compute] Port cleanup failed project=${currentProjectId(session)} port=${port.id} status=${error?.status || 'unknown'}`);
    }
  }
  return remaining;
}

function partialFailure(session, remaining) {
  console.error(`[compute] Manual port cleanup required project=${currentProjectId(session)} ports=${remaining.join(',')}`);
  return new OSError(502, 'Không thể hoàn tất thao tác network interface; cần kiểm tra port còn lại.', 'interface_partial_failure');
}

export async function createServerWithInterfaces(session, server, prepared, { request = osFetch } = {}) {
  const ports = [];
  let stage = 'port';
  try {
    for (const [index, spec] of prepared.specs.entries()) {
      ports.push(await createInterfacePort(session, prepared, spec, server.name, index, request));
    }
    stage = 'server';
    const data = await request(session, 'compute', '/servers', {
      method: 'POST', body: { server: { ...server, networks: ports.map((port) => ({ port: port.id })) } },
    });
    if (!data?.server?.id) throw partialFailure(session, ports.map((port) => port.id));
    return { data, ports };
  } catch (error) {
    // A timeout leaves Nova's acceptance unknown; deleting its ports could sever a live VM.
    if (stage === 'server' && error?.code === 'interface_partial_failure') throw error;
    if (['provider_timeout', 'provider_unavailable'].includes(error?.code)) throw partialFailure(session, ports.map((port) => port.id));
    const remaining = await rollbackInterfacePorts(session, ports, request);
    if (remaining.length) throw partialFailure(session, remaining);
    const auth = authorizationError(error);
    if (auth) throw auth;
    if (stage === 'server') {
      const status = error?.status >= 400 && error.status < 500 ? error.status : 502;
      throw new OSError(status, 'Nova không thể tạo VM bằng các port đã chuẩn bị.', 'interface_server_create_failed');
    }
    throw error;
  }
}

export async function attachInterface(session, serverId, input, { request = osFetch } = {}) {
  const prepared = await prepareInterfaces(session, [input], { request });
  const port = await createInterfacePort(session, prepared, prepared.specs[0], `vm-${serverId}`, 0, request);
  try {
    const data = await request(session, 'compute', `/servers/${encodeURIComponent(serverId)}/os-interface`, {
      method: 'POST', body: { interfaceAttachment: { port_id: port.id } },
    });
    if (data?.interfaceAttachment?.port_id !== port.id) throw partialFailure(session, [port.id]);
    return { data, port };
  } catch (error) {
    if (error?.code === 'interface_partial_failure') throw error;
    if (['provider_timeout', 'provider_unavailable'].includes(error?.code)) throw partialFailure(session, [port.id]);
    const remaining = await rollbackInterfacePorts(session, [port], request);
    if (remaining.length) throw partialFailure(session, remaining);
    const auth = authorizationError(error);
    if (auth) throw auth;
    const status = error?.status >= 400 && error.status < 500 ? error.status : 502;
    throw new OSError(status, 'Nova không thể gắn network interface.', 'interface_attach_failed');
  }
}
