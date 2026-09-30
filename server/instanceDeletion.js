import { OSError, osFetch } from './openstack.js';
import { assertOwned, isOwned, owned, projectQuery } from './projectScope.js';
import { isVipPort } from './vip.js';

const SERVER_POLLS = 20;
const PORT_POLLS = 8;
const POLL_DELAY_MS = 500;
const portPath = (id) => `/v2.0/ports/${encodeURIComponent(id)}`;
const serverPath = (id) => `/servers/${encodeURIComponent(id)}`;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isMissing = (error) => error?.status === 404;

export function isInstanceNic(port, instanceId, session) {
  return isOwned(port, session) && port.device_id === instanceId
    && port.device_owner?.startsWith('compute:') && !isVipPort(port);
}

async function waitForServerDeletion(session, instanceId, request, wait, attempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await request(session, 'compute', serverPath(instanceId)); }
    catch (error) {
      if (isMissing(error)) return true;
      if ([401, 403].includes(error?.status)) return false;
    }
    if (attempt < attempts - 1) await wait(POLL_DELAY_MS);
  }
  return false;
}

async function cleanCapturedPort(session, instanceId, snapshot, request, wait, attempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let port;
    try { port = (await request(session, 'network', portPath(snapshot.id)))?.port; }
    catch (error) {
      if (isMissing(error)) return { outcome: 'already_gone' };
      if ([401, 403].includes(error?.status)) return { outcome: 'failed', reason: 'permission' };
      if (attempt < attempts - 1) { await wait(POLL_DELAY_MS); continue; }
      return { outcome: 'failed', reason: 'provider' };
    }
    if (!port || !isOwned(port, session) || port.network_id !== snapshot.network_id || isVipPort(port)) {
      return { outcome: 'failed', reason: 'ownership_changed' };
    }
    if (port.device_id && port.device_id !== instanceId) return { outcome: 'failed', reason: 'rebound' };
    if (port.device_owner && !port.device_owner.startsWith('compute:')) {
      return { outcome: 'failed', reason: 'owner_changed' };
    }
    if (port.device_id === instanceId) {
      if (attempt < attempts - 1) { await wait(POLL_DELAY_MS); continue; }
      return { outcome: 'failed', reason: 'still_attached' };
    }
    try {
      await request(session, 'network', portPath(snapshot.id), { method: 'DELETE', responseType: 'none' });
      return { outcome: 'deleted' };
    } catch (error) {
      if (isMissing(error)) return { outcome: 'already_gone' };
      if (error?.status === 409 && attempt < attempts - 1) { await wait(POLL_DELAY_MS); continue; }
      return { outcome: 'failed', reason: error?.status === 409 ? 'dependency' : 'provider' };
    }
  }
  return { outcome: 'failed', reason: 'timeout' };
}

export async function deleteInstanceWithPorts(session, instanceId, {
  request = osFetch, wait = pause, serverPolls = SERVER_POLLS, portPolls = PORT_POLLS,
  onValidated = () => {},
} = {}) {
  const server = assertOwned((await request(session, 'compute', serverPath(instanceId)))?.server, session);
  onValidated(server);
  const path = projectQuery(session, '/v2.0/ports', { device_id: server.id });
  const discovered = (await request(session, 'network', path))?.ports;
  if (!Array.isArray(discovered)) throw new OSError(502, 'Neutron did not return a valid Port list.', 'provider_failure');
  const snapshots = owned(discovered, session).filter((port) => isInstanceNic(port, server.id, session))
    .map((port) => ({ id: port.id, network_id: port.network_id }));
  await request(session, 'compute', serverPath(server.id), { method: 'DELETE', responseType: 'none' });
  const instanceDeleted = await waitForServerDeletion(session, server.id, request, wait, serverPolls);
  const cleanup = { ports_captured: snapshots.length, ports_deleted: 0, ports_already_gone: 0,
    ports_failed: 0, failed_port_ids: [] };
  const warnings = [];
  if (!instanceDeleted) {
    cleanup.ports_pending = snapshots.length;
    warnings.push({ code: 'instance_delete_pending' });
    return { success: true, instance_deleted: false, server, cleanup, warnings };
  }
  for (const snapshot of snapshots) {
    const result = await cleanCapturedPort(session, server.id, snapshot, request, wait, portPolls);
    if (result.outcome === 'deleted') cleanup.ports_deleted++;
    else if (result.outcome === 'already_gone') cleanup.ports_already_gone++;
    else {
      cleanup.ports_failed++;
      cleanup.failed_port_ids.push(snapshot.id);
      warnings.push({ code: 'instance_port_cleanup_failed', port_id: snapshot.id, reason: result.reason });
    }
  }
  return { success: true, instance_deleted: true, server, cleanup, warnings };
}
