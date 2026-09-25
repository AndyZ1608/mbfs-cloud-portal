import { BlockList, isIP } from 'node:net';
import { OSError, osFetch } from './openstack.js';
import { isOwned, owned, projectQuery } from './projectScope.js';

const invalid = (code, message) => new OSError(400, message, code);
const pathId = (id) => encodeURIComponent(id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const poolValues = (pools) => pools.map((pool) => ({ start: pool.start, end: pool.end }));
const routerPort = (port) => ['network:router_interface', 'network:ha_router_replicated_interface', 'network:router_interface_distributed'].includes(port.device_owner);
const allowed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.includes(key));

function ipv4Number(address) {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

function inCidr(address, cidr) {
  const [base, bitsText] = String(cidr).split('/');
  const family = isIP(base);
  const bits = Number(bitsText);
  if (!family || isIP(address) !== family || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) return false;
  const block = new BlockList();
  block.addSubnet(base, bits, family === 4 ? 'ipv4' : 'ipv6');
  return block.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function checkPools(pools, subnet, gateway) {
  if (!Array.isArray(pools) || pools.some((pool) => !allowed(pool, ['start', 'end']) || !pool.start || !pool.end)) {
    throw invalid('network_edit_invalid_pool', 'Allocation Pool không hợp lệ.');
  }
  if (Number(subnet.ip_version) !== 4) throw invalid('network_edit_ipv6_pool_unsupported', 'Chỉnh sửa Allocation Pool IPv6 chưa được CMP hỗ trợ.');
  const [base, bitsText] = subnet.cidr.split('/');
  const bits = Number(bitsText);
  const network = (ipv4Number(base) & (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0)) >>> 0;
  const broadcast = network + 2 ** (32 - bits) - 1;
  const ranges = pools.map((pool) => {
    const start = ipv4Number(pool.start);
    const end = ipv4Number(pool.end);
    if (start === null || end === null || start > end || !inCidr(pool.start, subnet.cidr) || !inCidr(pool.end, subnet.cidr)
      || start <= network || end >= broadcast || (gateway && start <= ipv4Number(gateway) && ipv4Number(gateway) <= end)) {
      throw invalid('network_edit_invalid_pool', 'Allocation Pool không hợp lệ hoặc chồng lấn Gateway.');
    }
    return { start, end };
  }).sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index && range.start <= ranges[index - 1].end)) {
    throw invalid('network_edit_invalid_pool', 'Các Allocation Pool chồng lấn nhau.');
  }
}

export async function loadNetworkEdit(session, networkId, request = osFetch) {
  const network = (await request(session, 'network', `/v2.0/networks/${pathId(networkId)}`))?.network;
  // Consumption visibility never grants the right to mutate a provider/shared network.
  if (!isOwned(network, session) || network.shared || network['router:external']) {
    throw new OSError(404, 'Không tìm thấy Network có thể chỉnh sửa trong project hiện tại.', 'resource_not_found');
  }
  const subnets = await Promise.all((network.subnets || []).map(async (id) => {
    const subnet = (await request(session, 'network', `/v2.0/subnets/${pathId(id)}`))?.subnet;
    if (!isOwned(subnet, session) || subnet.network_id !== network.id) {
      throw new OSError(404, 'Không tìm thấy Subnet trong project hiện tại.', 'resource_not_found');
    }
    return subnet;
  }));
  const [portResponse, routerResponse] = await Promise.all([
    request(session, 'network', `/v2.0/ports?network_id=${pathId(network.id)}`),
    request(session, 'network', projectQuery(session, '/v2.0/routers')),
  ]);
  const routers = owned(routerResponse?.routers, session);
  const routing = new Map(subnets.map((subnet) => [subnet.id, null]));
  for (const port of portResponse?.ports || []) {
    if (port.network_id !== network.id) continue;
    const owner = port.device_owner || '';
    if (!routerPort(port)) {
      if (owner.startsWith('network:router_') || owner.includes('router_interface')) {
        throw new OSError(409, 'Router interface không được CMP hỗ trợ.', 'network_edit_unmanaged_topology');
      }
      continue;
    }
    for (const fixed of port.fixed_ips || []) {
      if (!routing.has(fixed.subnet_id)) continue;
      if (!isOwned(port, session) || !routers.some((router) => router.id === port.device_id)
        || routing.get(fixed.subnet_id)) {
        throw new OSError(409, 'Subnet có Router interface không do project hiện tại quản lý.', 'network_edit_unmanaged_topology');
      }
      routing.set(fixed.subnet_id, port.device_id);
    }
  }
  return { network, routers, subnets: subnets.map((subnet) => ({
    ...subnet, mode: routing.get(subnet.id) ? 'routed' : 'isolated', router_id: routing.get(subnet.id),
  })) };
}

function planEdit(current, input) {
  if (!allowed(input, ['name', 'revision_number', 'subnets']) || typeof input.name !== 'string' || !input.name.trim()
    || !Array.isArray(input.subnets) || input.subnets.length !== current.subnets.length) {
    throw invalid('network_edit_invalid_request', 'Dữ liệu chỉnh sửa Network không hợp lệ.');
  }
  if (current.network.revision_number != null && input.revision_number !== current.network.revision_number) {
    throw new OSError(409, 'Network đã thay đổi. Vui lòng tải lại.', 'network_edit_stale');
  }
  const byId = new Map(current.subnets.map((subnet) => [subnet.id, subnet]));
  const seen = new Set();
  const changes = [];
  for (const desired of input.subnets) {
    if (!allowed(desired, ['id', 'revision_number', 'name', 'gateway_ip', 'dns_nameservers', 'allocation_pools', 'mode', 'router_id'])
      || !byId.has(desired.id) || seen.has(desired.id) || typeof desired.name !== 'string'
      || !['routed', 'isolated'].includes(desired.mode)) {
      throw invalid('network_edit_invalid_request', 'Dữ liệu chỉnh sửa Subnet không hợp lệ.');
    }
    seen.add(desired.id);
    const old = byId.get(desired.id);
    if (old.revision_number != null && desired.revision_number !== old.revision_number) {
      throw new OSError(409, 'Subnet đã thay đổi. Vui lòng tải lại.', 'network_edit_stale');
    }
    const gateway = desired.gateway_ip === '' || desired.gateway_ip === null ? null : desired.gateway_ip;
    if (gateway !== null && (typeof gateway !== 'string' || !inCidr(gateway, old.cidr))) {
      throw invalid('network_edit_invalid_gateway', 'Gateway phải thuộc CIDR của Subnet.');
    }
    if (!Array.isArray(desired.dns_nameservers) || desired.dns_nameservers.some((ip) => typeof ip !== 'string' || !isIP(ip))) {
      throw invalid('network_edit_invalid_dns', 'DNS Nameserver phải là địa chỉ IP hợp lệ.');
    }
    const pools = desired.allocation_pools;
    if (!Array.isArray(pools) || pools.some((pool) => !allowed(pool, ['start', 'end']) || !pool.start || !pool.end)) {
      throw invalid('network_edit_invalid_pool', 'Allocation Pool không hợp lệ.');
    }
    const oldPools = old.allocation_pools || [];
    const poolsChanged = !same(poolValues(pools), poolValues(oldPools));
    if (poolsChanged || (gateway !== (old.gateway_ip ?? null) && Number(old.ip_version) === 4)) checkPools(pools, old, gateway);
    const patch = {};
    if (desired.name.trim() !== (old.name || '')) patch.name = desired.name.trim();
    if (gateway !== (old.gateway_ip ?? null)) patch.gateway_ip = gateway;
    if (!same(desired.dns_nameservers, old.dns_nameservers || [])) patch.dns_nameservers = desired.dns_nameservers;
    if (poolsChanged) patch.allocation_pools = pools;
    const routerId = desired.mode === 'routed' ? desired.router_id : null;
    if (desired.mode === 'routed' && (typeof routerId !== 'string' || !routerId)) {
      throw invalid('network_edit_router_required', 'Vui lòng chọn Router cho Subnet Routed.');
    }
    if (desired.mode === 'isolated' && desired.router_id) {
      throw invalid('network_edit_invalid_request', 'Subnet Isolated không được chỉ định Router.');
    }
    changes.push({ old, patch, routerId });
  }
  const networkPatch = input.name.trim() !== current.network.name ? { name: input.name.trim() } : null;
  return { networkPatch, changes };
}

export async function editNetwork(session, networkId, input, request = osFetch) {
  const current = structuredClone(await loadNetworkEdit(session, networkId, request));
  const { networkPatch, changes } = planEdit(current, input);
  for (const { routerId } of changes) {
    if (routerId && !current.routers.some((router) => router.id === routerId)) {
      throw new OSError(404, 'Router không có trong project hiện tại.', 'resource_not_found');
    }
  }
  const undo = [];
  const events = [];
  let stage = 'network';
  const put = (path, body) => request(session, 'network', path, { method: 'PUT', body });
  try {
    if (networkPatch) {
      await put(`/v2.0/networks/${pathId(networkId)}`, { network: networkPatch });
      undo.push(() => put(`/v2.0/networks/${pathId(networkId)}`, { network: { name: current.network.name } }));
      events.push({ action: 'network.rename', details: { old_name: current.network.name, new_name: networkPatch.name } });
    }
    for (const { old, patch, routerId } of changes) {
      stage = `subnet ${old.id}`;
      if (Object.keys(patch).length) {
        await put(`/v2.0/subnets/${pathId(old.id)}`, { subnet: patch });
        const restore = Object.fromEntries(Object.keys(patch).map((key) => [key,
          old[key] ?? (key === 'gateway_ip' ? null : key === 'name' ? '' : [])]));
        undo.push(() => put(`/v2.0/subnets/${pathId(old.id)}`, { subnet: restore }));
        for (const [key, action] of Object.entries({ name: 'subnet.update', gateway_ip: 'subnet.gateway.update',
          dns_nameservers: 'subnet.dns.update', allocation_pools: 'subnet.allocation_pool.update' })) {
          if (key in patch) events.push({ action, details: { subnet_id: old.id,
            ...(key === 'name' ? { old_name: old.name, new_name: patch.name } : {}),
            ...(key === 'gateway_ip' ? { old_gateway: old.gateway_ip ?? null, new_gateway: patch.gateway_ip } : {}) } });
        }
      }
      if (routerId === old.router_id) continue;
      if (old.router_id) {
        stage = `detach ${old.id}`;
        await put(`/v2.0/routers/${pathId(old.router_id)}/remove_router_interface`, { subnet_id: old.id });
        undo.push(() => put(`/v2.0/routers/${pathId(old.router_id)}/add_router_interface`, { subnet_id: old.id }));
      }
      if (routerId) {
        stage = `attach ${old.id}`;
        await put(`/v2.0/routers/${pathId(routerId)}/add_router_interface`, { subnet_id: old.id });
        undo.push(() => put(`/v2.0/routers/${pathId(routerId)}/remove_router_interface`, { subnet_id: old.id }));
      }
      events.push({ action: old.router_id && routerId ? 'network.routing.change'
        : routerId ? 'network.routing.attach' : 'network.routing.detach',
      details: { subnet_id: old.id, old_router_id: old.router_id || null, new_router_id: routerId || null } });
    }
    return { ...(await loadNetworkEdit(session, networkId, request)), events };
  } catch (error) {
    let rollbackFailed = false;
    for (const reverse of undo.reverse()) {
      try { await reverse(); } catch { rollbackFailed = true; }
    }
    // A timeout/5xx may occur after Neutron committed the in-flight mutation.
    // Even successful compensation of earlier steps cannot prove the final state.
    if (rollbackFailed || error?.status >= 500) {
      const partial = new OSError(502, 'Chỉnh sửa Network chưa hoàn tất; cần kiểm tra trạng thái Neutron.', 'network_edit_partial_failure');
      partial.resourceIds = { networkId, subnetId: changes.find(({ old }) => stage.includes(old.id))?.old.id || null };
      throw partial;
    }
    if (error instanceof OSError && error.code === 'network_edit_stale') throw error;
    const status = [400, 403, 404, 409, 412].includes(error?.status) ? error.status : 502;
    const code = stage.startsWith('subnet ') ? 'network_edit_subnet_failed'
      : stage.startsWith('attach ') || stage.startsWith('detach ') ? 'network_edit_routing_failed' : 'network_edit_failed';
    throw new OSError(status, `Neutron từ chối bước ${stage}; các thay đổi trước đó đã được hoàn tác.`, code);
  }
}
