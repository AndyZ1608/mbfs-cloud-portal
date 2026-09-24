import { isIP } from 'node:net';
import { OSError, osFetch } from './openstack.js';
import { currentProjectId, fetchOwned } from './projectScope.js';

const invalid = (code, message) => new OSError(400, message, code);
const missing = () => new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');

function ipv4Number(value) {
  if (isIP(value) !== 4) return null;
  return value.split('.').reduce((number, octet) => (number * 256) + Number(octet), 0);
}

export function validateNetworkCreate(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const cidr = typeof input.cidr === 'string' ? input.cidr.trim() : '';
  if (!name || !cidr) throw invalid('network_name_cidr_required', 'Thiếu tên network hoặc CIDR');
  const [address, bits, extra] = cidr.split('/');
  const prefix = /^\d{1,2}$/.test(bits || '') ? Number(bits) : -1;
  const base = ipv4Number(address);
  if (extra !== undefined || base === null || prefix < 0 || prefix > 32) {
    throw invalid('invalid_network_cidr', 'CIDR IPv4 không hợp lệ.');
  }
  const gateway_ip = typeof input.gateway_ip === 'string' ? input.gateway_ip.trim() : '';
  if (gateway_ip) {
    const gateway = ipv4Number(gateway_ip);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (gateway === null || ((gateway & mask) >>> 0) !== ((base & mask) >>> 0)) {
      throw invalid('invalid_network_gateway', 'Gateway phải thuộc CIDR của subnet.');
    }
  }
  const mode = input.mode === undefined ? 'isolated' : input.mode;
  if (!['routed', 'isolated'].includes(mode)) throw invalid('invalid_network_mode', 'Chế độ network không hợp lệ.');
  const router_id = typeof input.router_id === 'string' ? input.router_id.trim() : '';
  if (mode === 'routed' && !router_id) throw invalid('network_router_required', 'Vui lòng chọn Router cho network Routed.');
  return { name, cidr, gateway_ip, mode, router_id: mode === 'routed' ? router_id : '', dns: input.dns };
}

function stageError(error, code, message) {
  if (error?.status === 401 || error?.status === 403) return error;
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 502;
  return new OSError(status, message, code);
}

function partialFailure(networkId, subnetId) {
  const error = new OSError(502, 'Không thể hoàn tất tạo network; cần kiểm tra tài nguyên còn lại.', 'network_partial_failure');
  error.resourceIds = { networkId, subnetId };
  return error;
}

export async function createNetwork(session, input, { request = osFetch, ownedRouter = fetchOwned } = {}) {
  const { name, cidr, gateway_ip, mode, router_id, dns } = validateNetworkCreate(input);
  const projectId = currentProjectId(session);
  if (mode === 'routed') {
    try { await ownedRouter(session, 'network', `/v2.0/routers/${encodeURIComponent(router_id)}`, 'router'); }
    catch (error) { if (error?.status === 404) throw missing(); else throw error; }
  }

  let network;
  try {
    network = (await request(session, 'network', '/v2.0/networks', {
      method: 'POST', body: { network: { name, project_id: projectId } },
    })).network;
  } catch (error) { throw stageError(error, 'network_create_failed', 'Không thể tạo network.'); }

  let subnet;
  try {
    const spec = {
      network_id: network.id, project_id: projectId, name: `${name}-subnet`, cidr,
      ip_version: 4, enable_dhcp: true,
    };
    if (gateway_ip) spec.gateway_ip = gateway_ip;
    if (dns) spec.dns_nameservers = String(dns).split(',').map((server) => server.trim()).filter(Boolean);
    subnet = (await request(session, 'network', '/v2.0/subnets', {
      method: 'POST', body: { subnet: spec },
    })).subnet;
  } catch (error) {
    try { await request(session, 'network', `/v2.0/networks/${encodeURIComponent(network.id)}`, { method: 'DELETE' }); }
    catch { throw partialFailure(network.id, null); }
    throw stageError(error, 'network_subnet_failed', 'Không thể tạo subnet; network mới đã được xoá.');
  }

  if (mode === 'routed') {
    try {
      await request(session, 'network', `/v2.0/routers/${encodeURIComponent(router_id)}/add_router_interface`, {
        method: 'PUT', body: { subnet_id: subnet.id },
      });
    } catch (error) {
      let cleanupFailed = false;
      // A timeout may arrive after Neutron attached the interface. This subnet was just created here.
      try {
        await request(session, 'network', `/v2.0/routers/${encodeURIComponent(router_id)}/remove_router_interface`, {
          method: 'PUT', body: { subnet_id: subnet.id },
        });
      } catch { /* Not attached (or already gone); subnet/network deletion below is authoritative. */ }
      try { await request(session, 'network', `/v2.0/subnets/${encodeURIComponent(subnet.id)}`, { method: 'DELETE' }); }
      catch { cleanupFailed = true; }
      try { await request(session, 'network', `/v2.0/networks/${encodeURIComponent(network.id)}`, { method: 'DELETE' }); }
      catch { cleanupFailed = true; }
      if (cleanupFailed) throw partialFailure(network.id, subnet.id);
      throw stageError(error, 'network_router_attach_failed', 'Không thể gắn subnet vào Router; network và subnet mới đã được xoá.');
    }
  }

  return {
    success: true, mode,
    network: { ...network, subnet_details: [subnet] }, subnet,
    ...(mode === 'routed' ? { router_id } : {}),
  };
}
