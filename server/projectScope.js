import { OSError, osFetch } from './openstack.js';

export function currentProjectId(session) {
  const id = session?.project?.id;
  if (typeof id !== 'string' || !id) throw new OSError(401, 'Chưa có project hiện tại.', 'authentication_required');
  return id;
}

export function resourceProjectId(resource) {
  const project = resource?.project_id;
  const tenant = resource?.tenant_id;
  const cinderTenant = resource?.['os-vol-tenant-attr:tenant_id'];
  const cinderSnapshotProject = resource?.['os-extended-snapshot-attributes:project_id'];
  const values = [project, tenant, cinderTenant, cinderSnapshotProject].filter(Boolean);
  if (new Set(values).size > 1) return null;
  return values[0] || null;
}

export function isOwned(resource, session) {
  return resourceProjectId(resource) === currentProjectId(session);
}

export function owned(resources, session) {
  return (Array.isArray(resources) ? resources : []).filter((resource) => isOwned(resource, session));
}

export function assertOwned(resource, session) {
  if (!resource || !isOwned(resource, session)) {
    throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
  }
  return resource;
}

export async function fetchOwned(session, service, path, field) {
  const result = await osFetch(session, service, path);
  return assertOwned(field ? result?.[field] : result, session);
}

export function projectQuery(session, path, more = {}) {
  const query = new URLSearchParams({ project_id: currentProjectId(session), ...more });
  return `${path}?${query}`;
}

export function isUsableNetwork(network, session) {
  return !network?.['router:external'] && (isOwned(network, session) || network?.shared === true);
}

export async function fetchUsableNetwork(session, id) {
  const network = (await osFetch(session, 'network', `/v2.0/networks/${encodeURIComponent(id)}`))?.network;
  if (!isUsableNetwork(network, session)) {
    throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
  }
  return network;
}

export async function fetchUsableSubnet(session, id) {
  const subnet = (await osFetch(session, 'network', `/v2.0/subnets/${encodeURIComponent(id)}`))?.subnet;
  if (!subnet) throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
  const network = await fetchUsableNetwork(session, subnet.network_id);
  if (!isOwned(subnet, session) && !network.shared) {
    throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
  }
  return subnet;
}

// Glance public/community images are cloud-wide; shared images require an accepted membership.
export async function isUsableImage(session, image) {
  if (!image) return false;
  if (image.owner === currentProjectId(session) || ['public', 'community'].includes(image.visibility)) return true;
  if (image.visibility !== 'shared') return false;
  const members = await osFetch(session, 'image', `/v2/images/${encodeURIComponent(image.id)}/members`).catch(() => null);
  return !!members?.members?.some((member) => member.member_id === currentProjectId(session) && member.status === 'accepted');
}

export async function fetchUsableImage(session, id) {
  const image = await osFetch(session, 'image', `/v2/images/${encodeURIComponent(id)}`);
  if (!await isUsableImage(session, image)) {
    throw new OSError(404, 'Không tìm thấy tài nguyên trong project hiện tại.', 'resource_not_found');
  }
  return image;
}
