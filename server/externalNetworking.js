import { BlockList, isIP } from 'node:net';
import { config } from './config.js';
import { OSError, osFetch } from './openstack.js';
import { assertOwned, currentProjectId, isOwned, owned, projectQuery } from './projectScope.js';

const pathId = (id) => encodeURIComponent(id);
const invalidConfig = (code) => new OSError(503, 'External networking is not configured correctly.', code);
const routerInterface = (port) => ['network:router_interface', 'network:ha_router_replicated_interface',
  'network:router_interface_distributed'].includes(port?.device_owner);

function requireNetworking(networking) {
  if (!networking.externalNetworkId || !networking.floatingIpSubnetId || networking.errors?.length) {
    throw invalidConfig('external_network_unconfigured');
  }
}

export async function configuredExternalNetwork(session, { request = osFetch, networking = config.networking } = {}) {
  currentProjectId(session);
  requireNetworking(networking);
  let network;
  try {
    network = (await request(session, 'network', `/v2.0/networks/${pathId(networking.externalNetworkId)}`))?.network;
  } catch (error) {
    if (error?.status === 404) throw invalidConfig('external_network_invalid');
    throw error;
  }
  if (network?.id !== networking.externalNetworkId || network['router:external'] !== true) {
    throw invalidConfig('external_network_invalid');
  }
  return network;
}

export async function configuredFloatingIpSubnet(session, options = {}) {
  const { request = osFetch, networking = config.networking } = options;
  await configuredExternalNetwork(session, options);
  let subnet;
  try {
    subnet = (await request(session, 'network', `/v2.0/subnets/${pathId(networking.floatingIpSubnetId)}`))?.subnet;
  } catch (error) {
    if (error?.status === 404) throw invalidConfig('floating_ip_subnet_invalid');
    throw error;
  }
  if (subnet?.id !== networking.floatingIpSubnetId || subnet.network_id !== networking.externalNetworkId
    || Number(subnet.ip_version) !== 4 || !Array.isArray(subnet.allocation_pools)
    || subnet.allocation_pools.length === 0) {
    throw invalidConfig('floating_ip_subnet_invalid');
  }
  return subnet;
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

export async function createConfiguredRouter(session, name, { request = osFetch, networking = config.networking } = {}) {
  const projectId = currentProjectId(session);
  await configuredExternalNetwork(session, { request, networking });
  let created;
  try {
    const data = await request(session, 'network', '/v2.0/routers', { method: 'POST', body: {
      router: { name, project_id: projectId, admin_state_up: true,
        external_gateway_info: { network_id: networking.externalNetworkId } },
    } });
    created = assertOwned(data?.router, session);
    const verified = assertOwned((await request(session, 'network', `/v2.0/routers/${pathId(created.id)}`))?.router, session);
    if (verified.external_gateway_info?.network_id !== networking.externalNetworkId) {
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
      return new OSError(409, 'No Floating IP address is available in the configured pool.', 'floating_ip_pool_exhausted');
    }
  }
  return error;
}

export async function allocateConfiguredFloatingIp(session, { portId = null, request = osFetch,
  networking = config.networking } = {}) {
  const projectId = currentProjectId(session);
  const subnet = await configuredFloatingIpSubnet(session, { request, networking });
  if (portId) {
    const port = assertOwned((await request(session, 'network', `/v2.0/ports/${pathId(portId)}`))?.port, session);
    await assertPortExternalPath(session, port, networking.externalNetworkId, request);
  }
  let data;
  try {
    data = await request(session, 'network', '/v2.0/floatingips', { method: 'POST', body: {
      floatingip: { floating_network_id: networking.externalNetworkId,
        subnet_id: networking.floatingIpSubnetId, project_id: projectId,
        ...(portId ? { port_id: portId } : {}) },
    } });
  } catch (error) { throw fipAllocationError(error); }
  const fip = assertOwned(data?.floatingip, session);
  if (fip.floating_network_id === networking.externalNetworkId
    && inFloatingIpPool(fip.floating_ip_address, subnet)
    && (!fip.subnet_id || fip.subnet_id === networking.floatingIpSubnetId)) return { floatingip: fip };
  try {
    await request(session, 'network', `/v2.0/floatingips/${pathId(fip.id)}`, { method: 'DELETE' });
  } catch {
    console.error(`[network] Floating IP range rollback failed fip=${fip.id}`);
    throw new OSError(502, 'Floating IP was allocated outside the configured pool and needs operator cleanup.', 'floating_ip_range_partial_failure');
  }
  throw new OSError(502, 'Floating IP was allocated outside the configured pool.', 'floating_ip_range_mismatch');
}

export async function assertPortExternalPath(session, port, externalNetworkId, request = osFetch) {
  assertOwned(port, session);
  if (!port.fixed_ips?.length) throw new OSError(409, 'The target port has no fixed IP.', 'floating_ip_no_route');
  const data = await request(session, 'network', projectQuery(session, '/v2.0/ports', { network_id: port.network_id }));
  const interfaces = owned(data?.ports, session).filter(routerInterface);
  for (const iface of interfaces) {
    if (!iface.fixed_ips?.some((ip) => port.fixed_ips.some((fixed) => fixed.subnet_id === ip.subnet_id))) continue;
    const router = (await request(session, 'network', `/v2.0/routers/${pathId(iface.device_id)}`))?.router;
    if (router && isOwned(router, session)
      && router.external_gateway_info?.network_id === externalNetworkId) return;
  }
  throw new OSError(409, 'The virtual machine network does not have external connectivity.', 'floating_ip_no_route');
}
