import { isIP } from 'node:net';
import { OSError, osFetch } from './openstack.js';
import { assertOwned, fetchOwned, owned, projectQuery, currentProjectId } from './projectScope.js';
import { validateFixedIp } from './instanceInterfaces.js';

export const VIP_TAG = 'cmp-vip';
const missing = () => new OSError(404, 'VIP or interface not found in the current project.', 'resource_not_found');
const invalid = (code, message) => new OSError(400, message, code);
const portPath = (id) => `/v2.0/ports/${encodeURIComponent(id)}`;

export function hostAddress(value) {
  if (typeof value !== 'string') return null;
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address);
  if (!family || extra !== undefined || (prefix !== undefined && prefix !== String(family === 4 ? 32 : 128))) return null;
  return family === 4 ? address : new URL(`http://[${address}]/`).hostname;
}

export const vipPair = (ip) => ({ ip_address: `${ip}/${isIP(ip) === 4 ? 32 : 128}` });
const matchesVipPair = (port, pair, ip) => hostAddress(pair.ip_address) === hostAddress(ip)
  && (!pair.mac_address || pair.mac_address.toLowerCase() === port.mac_address?.toLowerCase());
export const hasVipPair = (port, ip) => (port.allowed_address_pairs || []).some((pair) => matchesVipPair(port, pair, ip));

export function isVipPort(port) {
  return Array.isArray(port?.tags) && port.tags.includes(VIP_TAG)
    && port.admin_state_up === false && port.port_security_enabled === false
    && Array.isArray(port.security_groups) && port.security_groups.length === 0
    && !port.device_id && !port.device_owner && !port['binding:host_id']
    && (!port['binding:vif_type'] || port['binding:vif_type'] === 'unbound')
    && port.fixed_ips?.length === 1
    && isIP(port.fixed_ips[0].ip_address) > 0;
}

export async function ownedSubnet(session, subnetId, request = osFetch) {
  const subnet = assertOwned((await request(session, 'network', `/v2.0/subnets/${encodeURIComponent(subnetId)}`))?.subnet, session);
  const network = assertOwned((await request(session, 'network', `/v2.0/networks/${encodeURIComponent(subnet.network_id)}`))?.network, session);
  if (network['router:external'] || !network.subnets?.includes(subnet.id)) throw missing();
  return { subnet, network };
}

export async function projectPorts(session, request = osFetch, networkId = null) {
  const path = projectQuery(session, '/v2.0/ports', networkId ? { network_id: networkId } : {});
  return owned((await request(session, 'network', path))?.ports, session);
}

export async function projectServers(session, request = osFetch) {
  return owned((await request(session, 'compute', '/servers/detail'))?.servers, session);
}

export function eligibleVmPorts(ports, servers, subnetId) {
  const names = new Map(servers.map((server) => [server.id, server.name]));
  return ports.filter((port) => port.device_owner?.startsWith('compute:') && names.has(port.device_id)
    && port.fixed_ips?.some((fixed) => fixed.subnet_id === subnetId))
    .map((port) => ({ ...port, instance_name: names.get(port.device_id) }));
}

export async function getVip(session, id, request = osFetch) {
  const port = assertOwned((await request(session, 'network', portPath(id)))?.port, session);
  if (!isVipPort(port)) throw missing();
  const { subnet, network } = await ownedSubnet(session, port.fixed_ips[0].subnet_id, request);
  if (port.network_id !== network.id) throw missing();
  return { port, subnet, network };
}

export async function subnetPorts(session, subnetId, request = osFetch) {
  const { subnet, network } = await ownedSubnet(session, subnetId, request);
  const ports = (await projectPorts(session, request, network.id))
    .filter((port) => port.fixed_ips?.some((fixed) => fixed.subnet_id === subnet.id));
  return { subnet, network, ports };
}

export async function subnetVips(session, subnetId, request = osFetch) {
  const { subnet, network, ports } = await subnetPorts(session, subnetId, request);
  const servers = await projectServers(session, request);
  const targets = eligibleVmPorts(ports, servers, subnet.id);
  const vips = ports.filter(isVipPort).map((port) => ({ ...port,
    assignment_count: targets.filter((candidate) => candidate.id !== port.id
      && hasVipPair(candidate, port.fixed_ips[0].ip_address)).length }));
  return { subnet, network, vips };
}

export async function createVip(session, subnetId, input, request = osFetch) {
  const { subnet, network } = await ownedSubnet(session, subnetId, request);
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const ip = input?.ip_address;
  if (!name || name.length > 255) throw invalid('vip_name_invalid', 'Enter a VIP name.');
  if (typeof ip !== 'string' || !ip.trim()) throw invalid('vip_address_required', 'Choose an explicit VIP address.');
  validateFixedIp(ip, subnet);
  let extensions;
  try { extensions = (await request(session, 'network', '/v2.0/extensions'))?.extensions || []; }
  catch { throw new OSError(409, 'Neutron port tagging could not be verified.', 'vip_tags_unavailable'); }
  if (!extensions.some((item) => item.alias === 'standard-attr-tag')) {
    throw new OSError(409, 'Neutron port tags are required for CMP VIP management.', 'vip_tags_unavailable');
  }
  const ports = await projectPorts(session, request, network.id);
  if (ports.some((port) => port.fixed_ips?.some((fixed) => fixed.ip_address === ip))) {
    throw new OSError(409, 'VIP address is already in use.', 'vip_address_in_use');
  }
  let port;
  try {
    port = (await request(session, 'network', '/v2.0/ports', { method: 'POST', body: { port: {
      name, network_id: network.id, project_id: currentProjectId(session),
      admin_state_up: false, port_security_enabled: false, security_groups: [],
      device_id: '', device_owner: '', fixed_ips: [{ subnet_id: subnet.id, ip_address: ip }],
    } } }))?.port;
  } catch (error) {
    if ([400, 409].includes(error?.status) && /(?:already|allocated|in use|duplicate)/i.test(error.message || '')) {
      throw new OSError(409, 'VIP address is already in use.', 'vip_address_in_use');
    }
    if ([400, 403, 409].includes(error?.status)) {
      throw new OSError(error.status, 'Neutron rejected this VIP reservation Port.', 'vip_create_rejected');
    }
    throw error;
  }
  if (!port?.id) throw new OSError(502, 'Neutron Port creation outcome is unknown.', 'vip_create_uncertain');
  try {
    await request(session, 'network', `${portPath(port.id)}/tags/${VIP_TAG}`, { method: 'PUT', responseType: 'none' });
    return (await getVip(session, port.id, request)).port;
  } catch (error) {
    try { await request(session, 'network', portPath(port.id), { method: 'DELETE', responseType: 'none' }); }
    catch { throw new OSError(502, 'VIP Port tagging failed and cleanup must be checked.', 'vip_create_partial_failure'); }
    throw new OSError(409, 'Could not mark this Port as a CMP VIP.', 'vip_tag_failed');
  }
}

export async function deleteVip(session, id, request = osFetch) {
  const { port } = await getVip(session, id, request);
  const ports = await projectPorts(session, request);
  const count = ports.filter((candidate) => candidate.id !== port.id && hasVipPair(candidate, port.fixed_ips[0].ip_address)).length;
  if (count) {
    const error = new OSError(409, `VIP is assigned to ${count} interfaces.`, 'vip_delete_assigned');
    error.count = count;
    throw error;
  }
  await request(session, 'network', portPath(id), { method: 'DELETE', responseType: 'none' });
  return port;
}

export function changedVipPairs(port, changes) {
  const original = Array.isArray(port.allowed_address_pairs) ? port.allowed_address_pairs : [];
  let result = [...original];
  for (const { ip, assign } of changes) {
    if (assign && !result.some((pair) => matchesVipPair(port, pair, ip))) {
      if (result.some((pair) => hostAddress(pair.ip_address) === hostAddress(ip))) {
        throw new OSError(409, 'An external address pair already uses this VIP address.', 'vip_port_rejected');
      }
      result.push(vipPair(ip));
    }
    if (!assign) result = result.filter((pair) => !matchesVipPair(port, pair, ip));
  }
  return result.length === original.length && result.every((pair, index) => pair === original[index]) ? null : result;
}

export async function updateVmPortPairs(session, targetId, subnetId, changes, request = osFetch) {
  // Fresh provider read directly before the minimal AAP-only write.
  const port = assertOwned((await request(session, 'network', portPath(targetId)))?.port, session);
  const subnetIds = Array.isArray(subnetId) ? subnetId : [subnetId];
  if (!port.device_owner?.startsWith('compute:') || !port.device_id
    || !subnetIds.every((id) => port.fixed_ips?.some((fixed) => fixed.subnet_id === id))) throw missing();
  await fetchOwned(session, 'compute', `/servers/${encodeURIComponent(port.device_id)}`, 'server');
  const desired = changedVipPairs(port, changes);
  if (!desired) return { port, changed: false };
  try {
    const updated = (await request(session, 'network', portPath(targetId), { method: 'PUT',
      body: { port: { allowed_address_pairs: desired } } }))?.port;
    return { port: updated || { ...port, allowed_address_pairs: desired }, changed: true };
  } catch (error) {
    if ([400, 409].includes(error?.status)) {
      throw new OSError(409, 'VIP cannot be assigned with the current Port configuration.', 'vip_port_rejected');
    }
    throw error;
  }
}

export async function vipAssignments(session, id, request = osFetch) {
  const { port: vip, subnet } = await getVip(session, id, request);
  const [ports, servers] = await Promise.all([projectPorts(session, request, vip.network_id), projectServers(session, request)]);
  const targets = eligibleVmPorts(ports, servers, subnet.id).map((port) => ({ ...port,
    assigned: hasVipPair(port, vip.fixed_ips[0].ip_address) }));
  return { vip, subnet, targets };
}

export async function setVipAssignments(session, id, ids, request = osFetch) {
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((item) => typeof item !== 'string' || !item)
    || new Set(ids).size !== ids.length) throw invalid('vip_targets_invalid', 'Choose valid VM interfaces.');
  const { vip, subnet, targets } = await vipAssignments(session, id, request);
  const byId = new Map(targets.map((port) => [port.id, port]));
  if (ids.some((id) => !byId.has(id))) throw missing();
  const desired = new Set(ids);
  const changes = targets.filter((port) => desired.has(port.id) !== port.assigned);
  const events = [];
  for (const target of changes) {
    const assign = desired.has(target.id);
    try {
      const result = await updateVmPortPairs(session, target.id, subnet.id,
        [{ ip: vip.fixed_ips[0].ip_address, assign }], request);
      if (result.changed) events.push({ action: assign ? 'vip.assign' : 'vip.unassign', vip, target: result.port });
    } catch (error) {
      if (events.length) {
        const partial = new OSError(409, 'Some VIP assignments changed. Refresh before retrying.', 'vip_partial_failure');
        partial.events = events;
        partial.failedPortId = target.id;
        throw partial;
      }
      throw error;
    }
  }
  return { vip, events };
}

export async function portVips(session, id, request = osFetch) {
  const port = assertOwned((await request(session, 'network', portPath(id)))?.port, session);
  if (!port.device_owner?.startsWith('compute:') || !port.device_id) throw missing();
  await fetchOwned(session, 'compute', `/servers/${encodeURIComponent(port.device_id)}`, 'server');
  const [networkData, ports, subnetData] = await Promise.all([
    request(session, 'network', `/v2.0/networks/${encodeURIComponent(port.network_id)}`),
    projectPorts(session, request, port.network_id),
    request(session, 'network', projectQuery(session, '/v2.0/subnets'))]);
  const network = assertOwned(networkData?.network, session);
  if (network['router:external']) throw missing();
  const ownedSubnetIds = new Set(owned(subnetData.subnets, session).map((subnet) => subnet.id));
  const subnets = new Set((port.fixed_ips || []).map((fixed) => fixed.subnet_id));
  const vips = ports.filter((candidate) => isVipPort(candidate)
    && subnets.has(candidate.fixed_ips[0].subnet_id) && ownedSubnetIds.has(candidate.fixed_ips[0].subnet_id));
  return { port, vips: vips.map((vip) => ({ ...vip, assigned: hasVipPair(port, vip.fixed_ips[0].ip_address) })),
    external_pairs: (port.allowed_address_pairs || []).filter((pair) => !vips.some((vip) =>
      matchesVipPair(port, pair, vip.fixed_ips[0].ip_address))) };
}

export async function serverVips(session, serverId, request = osFetch) {
  await fetchOwned(session, 'compute', `/servers/${encodeURIComponent(serverId)}`, 'server');
  const [ports, networkData, subnetData] = await Promise.all([projectPorts(session, request),
    request(session, 'network', projectQuery(session, '/v2.0/networks')),
    request(session, 'network', projectQuery(session, '/v2.0/subnets'))]);
  const ownedNetworkIds = new Set(owned(networkData.networks, session)
    .filter((network) => !network['router:external']).map((network) => network.id));
  const subnetIdsOwned = new Set(owned(subnetData.subnets, session).map((subnet) => subnet.id));
  const reservations = ports.filter((port) => isVipPort(port) && ownedNetworkIds.has(port.network_id)
    && subnetIdsOwned.has(port.fixed_ips[0].subnet_id));
  return { ports: ports.filter((port) => port.device_id === serverId && port.device_owner?.startsWith('compute:'))
    .map((port) => {
      const subnetIds = new Set((port.fixed_ips || []).map((fixed) => fixed.subnet_id));
      const vips = reservations.filter((vip) => vip.network_id === port.network_id
        && subnetIds.has(vip.fixed_ips[0].subnet_id));
      return { id: port.id, manageable: ownedNetworkIds.has(port.network_id)
        && [...subnetIds].some((id) => subnetIdsOwned.has(id)),
      vips: vips.filter((vip) => hasVipPair(port, vip.fixed_ips[0].ip_address))
        .map((vip) => ({ id: vip.id, name: vip.name, ip_address: vip.fixed_ips[0].ip_address })),
      external_pairs: (port.allowed_address_pairs || []).filter((pair) => !vips.some((vip) =>
        matchesVipPair(port, pair, vip.fixed_ips[0].ip_address))) };
    }) };
}

export async function setPortVips(session, id, ids, request = osFetch) {
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((item) => typeof item !== 'string' || !item)
    || new Set(ids).size !== ids.length) throw invalid('vip_targets_invalid', 'Choose valid VIPs.');
  const { port, vips } = await portVips(session, id, request);
  const byId = new Map(vips.map((vip) => [vip.id, vip]));
  if (ids.some((vipId) => !byId.has(vipId))) throw missing();
  const desired = new Set(ids);
  const changes = vips.filter((vip) => desired.has(vip.id) !== vip.assigned).map((vip) => ({
    vip, ip: vip.fixed_ips[0].ip_address, assign: desired.has(vip.id),
  }));
  if (!changes.length) return { port, events: [] };
  const subnetIds = new Set(changes.map((item) => item.vip.fixed_ips[0].subnet_id));
  const result = await updateVmPortPairs(session, id, [...subnetIds], changes, request);
  return { port: result.port, events: result.changed ? changes.map((item) => ({
    action: item.assign ? 'vip.assign' : 'vip.unassign', vip: item.vip, target: result.port,
  })) : [] };
}
