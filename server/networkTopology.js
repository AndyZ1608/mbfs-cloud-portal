import { OSError, osFetch } from './openstack.js';
import { assertOwned, owned, projectQuery, currentProjectId } from './projectScope.js';
import { isVipPort, projectPorts, projectServers, subnetVips } from './vip.js';
import { validateNetworkCreate } from './networkCreation.js';

const conflict = () => new OSError(409, 'CMP supports exactly one Subnet per Network.', 'network_multiple_subnets');
const pendingSubnetCreates = new Set();

export async function networkTopology(session, networkId, request = osFetch) {
  const network = assertOwned((await request(session, 'network', `/v2.0/networks/${encodeURIComponent(networkId)}`))?.network, session);
  const subnets = owned((await request(session, 'network', projectQuery(session, '/v2.0/subnets', {
    network_id: networkId,
  })))?.subnets, session).filter((subnet) => subnet.network_id === network.id);
  const count = Math.max(network.subnets?.length || 0, subnets.length);
  const subnet_state = count === 0 ? 'none' : count === 1 && subnets.length === 1
    && (!network.subnets?.length || network.subnets[0] === subnets[0].id) ? 'single' : 'multiple';
  return { network, subnet_state, subnet: subnet_state === 'single' ? subnets[0] : null };
}

export async function networkResources(session, networkId, request = osFetch) {
  const topology = await networkTopology(session, networkId, request);
  const [ports, servers] = await Promise.all([
    projectPorts(session, request, networkId), projectServers(session, request).catch(() => []),
  ]);
  const vipData = topology.subnet_state === 'single'
    ? await subnetVips(session, topology.subnet.id, request) : { vips: [] };
  const names = new Map(servers.map((server) => [server.id, server.name]));
  return { ...topology,
    ports: ports.filter((port) => port.network_id === networkId).map((port) => ({ ...port,
      cmp_vip: isVipPort(port), instance_name: names.get(port.device_id) || null,
    })),
    vips: vipData.vips,
  };
}

export async function createOnlySubnet(session, networkId, input, request = osFetch) {
  const lockKey = `${currentProjectId(session)}:${networkId}`;
  if (pendingSubnetCreates.has(lockKey)) throw conflict();
  pendingSubnetCreates.add(lockKey);
  try {
    const { network, subnet_state } = await networkTopology(session, networkId, request);
    if (subnet_state !== 'none') throw conflict();
    if (network['router:external'] || network.shared) {
      throw new OSError(404, 'Network not found in the current project.', 'resource_not_found');
    }
    const { cidr, gateway_ip, dns } = validateNetworkCreate({
      name: network.name || 'Network', cidr: input?.cidr, gateway_ip: input?.gateway_ip,
      dns: input?.dns, mode: 'isolated',
    });
    // Recheck immediately before Neutron create; Neutron itself does not enforce this CMP rule.
    if ((await networkTopology(session, networkId, request)).subnet_state !== 'none') throw conflict();
    const spec = { network_id: network.id, project_id: currentProjectId(session),
      name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : `${network.name}-subnet`,
      cidr, ip_version: 4, enable_dhcp: input?.enable_dhcp !== false };
    if (gateway_ip) spec.gateway_ip = gateway_ip;
    if (dns) spec.dns_nameservers = String(dns).split(',').map((item) => item.trim()).filter(Boolean);
    const subnet = (await request(session, 'network', '/v2.0/subnets', { method: 'POST', body: { subnet: spec } }))?.subnet;
    return { subnet: assertOwned(subnet, session) };
  } finally { pendingSubnetCreates.delete(lockKey); }
}
