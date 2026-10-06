import { BlockList, isIP } from 'node:net';
import { OSError, osFetch } from './openstack.js';
import { assertOwned, currentProjectId, isOwned, owned, projectQuery } from './projectScope.js';

const pathId = (id) => encodeURIComponent(id);
const routerInterface = (port) => ['network:router_interface', 'network:ha_router_replicated_interface',
  'network:router_interface_distributed'].includes(port?.device_owner);

const stableId = (a, b) => a.id.localeCompare(b.id, 'en');
const unavailableNetwork = () => new OSError(409, 'No available External Network was found.', 'external_network_unavailable');

async function adminAccessibleNetworks(session, networks, request) {
  if (!session.roles?.includes('admin')) return networks; // Neutron has already scoped the visible list.
  const projectId = currentProjectId(session);
  const foreignPrivate = networks.filter((network) => !isOwned(network, session) && network.shared !== true);
  if (!foreignPrivate.length) return networks;
  let policies = [];
  try {
    policies = (await request(session, 'network', '/v2.0/rbac-policies?object_type=network&action=access_as_external'))?.rbac_policies || [];
  } catch {
    // An admin-visible foreign private network is not proof of tenant access.
    console.warn('[network] Could not verify external-network RBAC; omitting foreign private candidates');
  }
  return networks.filter((network) => isOwned(network, session) || network.shared === true || policies.some((policy) =>
    policy.object_type === 'network' && policy.object_id === network.id && policy.action === 'access_as_external'
    && ['*', projectId].includes(policy.target_project || policy.target_tenant)));
}

export async function discoverExternalNetwork(session, { request = osFetch } = {}) {
  currentProjectId(session);
  const data = await request(session, 'network', '/v2.0/networks?router:external=true');
  const visible = await adminAccessibleNetworks(session, (data?.networks || []).filter((network) =>
    network?.id && network['router:external'] === true && network.admin_state_up === true), request);
  if (!visible.length) throw unavailableNetwork();
  const defaults = visible.filter((network) => network.is_default === true);
  const candidates = defaults.length === 1 ? defaults : visible;
  if (visible.length > 1) console.warn(`[network] ${visible.length} usable External Networks; selecting ${
    candidates.toSorted(stableId)[0].id} by ${defaults.length === 1 ? 'Neutron is_default' : 'stable ID order'}`);
  return candidates.toSorted(stableId)[0];
}

function usableFloatingIpSubnet(subnet, networkId) {
  if (!subnet?.id || subnet.network_id !== networkId || Number(subnet.ip_version) !== 4) return false;
  if (Array.isArray(subnet.service_types) && subnet.service_types.length && !subnet.service_types.includes('network:floatingip')) return false;
  return Array.isArray(subnet.allocation_pools) && subnet.allocation_pools.some((pool) =>
    inFloatingIpPool(pool.start, subnet) && inFloatingIpPool(pool.end, subnet)
    && ipv4Number(pool.start) <= ipv4Number(pool.end));
}

export async function discoverFloatingIpSubnet(session, networkId, { request = osFetch } = {}) {
  currentProjectId(session);
  const data = await request(session, 'network', `/v2.0/subnets?network_id=${pathId(networkId)}`);
  const visible = (data?.subnets || []).filter((subnet) => usableFloatingIpSubnet(subnet, networkId));
  if (!visible.length) throw new OSError(409, 'No usable Floating IP subnet was found.', 'floating_ip_subnet_unavailable');
  const typed = visible.filter((subnet) => subnet.service_types?.includes('network:floatingip'));
  const candidates = typed.length ? typed : visible;
  if (visible.length > 1) console.warn(`[network] ${visible.length} usable Floating IP subnets on ${networkId}; selecting ${
    candidates.toSorted(stableId)[0].id} by ${typed.length ? 'network:floatingip service type then stable ID order' : 'stable ID order'}`);
  return candidates.toSorted(stableId)[0];
}

function ipv4Number(address) {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

export function inFloatingIpPool(address, subnet) {
  const value = ipv4Number(address);
  const [base, bitsText] = String(subnet?.cidr || '').split('/');
  const bits = Number(bitsText);
  if (value === null || isIP(base) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const block = new BlockList();
  block.addSubnet(base, bits, 'ipv4');
  if (!block.check(address, 'ipv4')) return false;
  return subnet.allocation_pools.some((pool) => {
    const start = ipv4Number(pool.start);
    const end = ipv4Number(pool.end);
    return start !== null && end !== null && start <= value && value <= end;
  });
}

export async function createDiscoveredRouter(session, name, { request = osFetch } = {}) {
  const projectId = currentProjectId(session);
  const external = await discoverExternalNetwork(session, { request });
  let created;
  try {
    const data = await request(session, 'network', '/v2.0/routers', { method: 'POST', body: {
      router: { name, project_id: projectId, admin_state_up: true,
        external_gateway_info: { network_id: external.id } },
    } });
    created = assertOwned(data?.router, session);
    const verified = assertOwned((await request(session, 'network', `/v2.0/routers/${pathId(created.id)}`))?.router, session);
    if (verified.external_gateway_info?.network_id !== external.id) {
      throw new OSError(502, 'Router external gateway was not configured.', 'router_gateway_failed');
    }
    return { router: verified };
  } catch (error) {
    if (!created?.id) throw error;
    try {
      const data = await request(session, 'network', projectQuery(session, '/v2.0/ports', { device_id: created.id }));
      if (owned(data?.ports, session).some(routerInterface)) throw new Error('Router has an attached tenant interface');
      await request(session, 'network', `/v2.0/routers/${pathId(created.id)}`, { method: 'DELETE' });
    } catch {
      console.error(`[network] Router gateway rollback failed router=${created.id}`);
      throw new OSError(502, 'Router gateway failed; the new Router needs operator cleanup.', 'router_gateway_partial_failure');
    }
    throw new OSError(502, 'Router could not be created with external connectivity.', 'router_gateway_failed');
  }
}

function fipAllocationError(error) {
  const message = String(error?.message || '');
  if (error?.status === 409 || error?.status === 400) {
    if (/quota/i.test(message)) return new OSError(409, 'Floating IP quota reached.', 'floating_ip_quota_exceeded');
    if (/no more|exhaust|not enough|no available|ipaddressgenerationfailure|address.*available/i.test(message)) {
      return new OSError(409, 'No Floating IP address is available in the selected External Network.', 'floating_ip_pool_exhausted');
    }
  }
  return error;
}

export async function allocateDiscoveredFloatingIp(session, { portId = null, request = osFetch } = {}) {
  const projectId = currentProjectId(session);
  let external;
  if (portId) {
    const port = assertOwned((await request(session, 'network', `/v2.0/ports/${pathId(portId)}`))?.port, session);
    if (!(port.device_owner || '').startsWith('compute') && port.device_owner !== 'octavia') {
      throw new OSError(404, 'Resource not found in the current project.', 'resource_not_found');
    }
    const path = await portExternalPath(session, port, { request });
    external = (await request(session, 'network', `/v2.0/networks/${pathId(path.networkId)}`))?.network;
    if (external?.id !== path.networkId || external['router:external'] !== true || external.admin_state_up !== true) {
      throw unavailableNetwork();
    }
  } else external = await discoverExternalNetwork(session, { request });
  const subnet = await discoverFloatingIpSubnet(session, external.id, { request });
  let data;
  try {
    data = await request(session, 'network', '/v2.0/floatingips', { method: 'POST', body: {
      floatingip: { floating_network_id: external.id,
        subnet_id: subnet.id, project_id: projectId,
        ...(portId ? { port_id: portId } : {}) },
    } });
  } catch (error) { throw fipAllocationError(error); }
  const fip = assertOwned(data?.floatingip, session);
  if (portId && fip.port_id !== portId) {
    if (fip.port_id) {
      console.error(`[network] Floating IP target mismatch requires operator cleanup fip=${fip.id}`);
      throw new OSError(502, 'Floating IP was attached to an unexpected port.', 'floating_ip_target_partial_failure');
    }
    try {
      await request(session, 'network', `/v2.0/floatingips/${pathId(fip.id)}`, { method: 'DELETE' });
    } catch {
      console.error(`[network] Floating IP target rollback failed fip=${fip.id}`);
      throw new OSError(502, 'Floating IP target mismatch requires operator cleanup.', 'floating_ip_target_partial_failure');
    }
    throw new OSError(502, 'Floating IP was not attached to the selected port.', 'floating_ip_target_mismatch');
  }
  if (fip.floating_network_id === external.id
    && inFloatingIpPool(fip.floating_ip_address, subnet)
    && (!fip.subnet_id || fip.subnet_id === subnet.id)) return { floatingip: fip };
  try {
    await request(session, 'network', `/v2.0/floatingips/${pathId(fip.id)}`, { method: 'DELETE' });
  } catch {
    console.error(`[network] Floating IP range rollback failed fip=${fip.id}`);
    throw new OSError(502, 'Floating IP was allocated outside the selected pool and needs operator cleanup.', 'floating_ip_range_partial_failure');
  }
  throw new OSError(502, 'Floating IP was allocated outside the selected pool.', 'floating_ip_range_mismatch');
}

export async function portExternalPath(session, port, { request = osFetch, networkId = null } = {}) {
  assertOwned(port, session);
  if (!port.fixed_ips?.length) throw new OSError(409, 'The target port has no fixed IP.', 'floating_ip_no_route');
  const data = await request(session, 'network', projectQuery(session, '/v2.0/ports', { network_id: port.network_id }));
  const interfaces = owned(data?.ports, session).filter(routerInterface);
  const paths = [];
  for (const iface of interfaces) {
    if (!iface.fixed_ips?.some((ip) => port.fixed_ips.some((fixed) => fixed.subnet_id === ip.subnet_id))) continue;
    const router = (await request(session, 'network', `/v2.0/routers/${pathId(iface.device_id)}`))?.router;
    const gatewayId = router?.external_gateway_info?.network_id;
    if (router?.id && isOwned(router, session) && gatewayId && (!networkId || gatewayId === networkId)) {
      paths.push({ routerId: router.id, networkId: gatewayId });
    }
  }
  if (paths.length) {
    if (paths.length > 1 && !networkId) console.warn(`[network] Multiple external Router paths for port=${port.id}; selecting stable Router ID`);
    return paths.toSorted((a, b) => a.routerId.localeCompare(b.routerId, 'en'))[0];
  }
  throw new OSError(409, 'The virtual machine network does not have external connectivity.', 'floating_ip_no_route');
}

export async function assertPortExternalPath(session, port, externalNetworkId, request = osFetch) {
  await portExternalPath(session, port, { request, networkId: externalNetworkId });
}
