import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteInstanceWithPorts, isInstanceNic } from '../instanceDeletion.js';

const session = { project: { id: 'project-a' } };
const server = () => ({ id: 'vm-a', name: 'VM-A', project_id: 'project-a' });
const nic = (id, overrides = {}) => ({ id, project_id: 'project-a', network_id: 'net-a',
  device_id: 'vm-a', device_owner: 'compute:nova', allowed_address_pairs: [], ...overrides });
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

function provider(initialPorts, onDelete = (ports) => {
  for (const port of ports.values()) {
    if (port.device_id === 'vm-a' && port.device_owner?.startsWith('compute:')) {
      port.device_id = ''; port.device_owner = '';
    }
  }
}) {
  const ports = new Map(initialPorts.map((port) => [port.id, structuredClone(port)]));
  const calls = [];
  let exists = true;
  const request = async (_session, service, path, options = {}) => {
    calls.push({ service, path, options });
    if (service === 'compute' && path === '/servers/vm-a') {
      if (options.method === 'DELETE') { exists = false; onDelete(ports); return null; }
      if (!exists) throw notFound();
      return { server: server() };
    }
    if (service === 'network' && path.startsWith('/v2.0/ports?')) {
      // Deliberately include foreign/system rows to prove local filtering is authoritative.
      return { ports: [...ports.values()] };
    }
    const match = service === 'network' && path.match(/^\/v2\.0\/ports\/([^/]+)$/);
    if (match) {
      const port = ports.get(match[1]);
      if (!port) throw notFound();
      if (options.method === 'DELETE') {
        if (port.device_id) throw Object.assign(new Error('still bound'), { status: 409 });
        ports.delete(match[1]); return null;
      }
      return { port };
    }
    throw new Error(`Unexpected provider call: ${service} ${path}`);
  };
  return { request, ports, calls };
}

test('Port-first boot NICs and added interfaces are captured before Nova delete and all cleaned', async () => {
  const vip = nic('vip-reservation', { device_id: '', device_owner: '', tags: ['cmp-vip'],
    admin_state_up: false, port_security_enabled: false, security_groups: [],
    fixed_ips: [{ subnet_id: 'sub-a', ip_address: '10.20.31.100' }] });
  const fixture = provider([
    nic('boot-port', { allowed_address_pairs: [{ ip_address: '10.20.31.100/32' }] }),
    nic('added-port-1'), nic('added-port-2'),
    nic('router-port', { device_owner: 'network:router_interface' }),
    nic('dhcp-port', { device_owner: 'network:dhcp' }),
    nic('foreign-port', { project_id: 'project-b' }),
    nic('other-vm-port', { device_id: 'vm-b' }), vip,
  ]);
  const result = await deleteInstanceWithPorts(session, 'vm-a', {
    request: fixture.request, wait: async () => {}, serverPolls: 2, portPolls: 2,
  });
  assert.equal(result.instance_deleted, true);
  assert.deepEqual(result.cleanup, { ports_captured: 3, ports_deleted: 3, ports_already_gone: 0,
    ports_failed: 0, failed_port_ids: [] });
  const deleted = fixture.calls.filter((call) => call.service === 'network' && call.options.method === 'DELETE')
    .map((call) => call.path);
  assert.deepEqual(deleted.sort(), ['/v2.0/ports/added-port-1', '/v2.0/ports/added-port-2',
    '/v2.0/ports/boot-port']);
  assert.ok(fixture.calls.findIndex((call) => call.service === 'network' && call.path.startsWith('/v2.0/ports?'))
    < fixture.calls.findIndex((call) => call.service === 'compute' && call.options.method === 'DELETE'));
  assert.ok(fixture.ports.has('vip-reservation'));
  assert.ok(fixture.ports.has('router-port'));
  assert.ok(fixture.ports.has('dhcp-port'));
  assert.ok(fixture.ports.has('foreign-port'));
  assert.ok(fixture.ports.has('other-vm-port'));
  assert.ok(!fixture.calls.some((call) => call.path.includes('floatingips') || call.service === 'volume'));
});

test('Nova-auto-deleted NIC is idempotent and a rebound NIC is never deleted', async () => {
  const fixture = provider([nic('already-gone'), nic('rebound')], (ports) => {
    ports.delete('already-gone');
    ports.get('rebound').device_id = 'vm-b';
  });
  const result = await deleteInstanceWithPorts(session, 'vm-a', {
    request: fixture.request, wait: async () => {}, serverPolls: 2, portPolls: 2,
  });
  assert.equal(result.instance_deleted, true);
  assert.equal(result.cleanup.ports_already_gone, 1);
  assert.deepEqual(result.cleanup.failed_port_ids, ['rebound']);
  assert.equal(result.warnings[0].reason, 'rebound');
  assert.ok(fixture.ports.has('rebound'));
});

test('attached/dependency failures return partial cleanup after irreversible server delete', async () => {
  const fixture = provider([nic('port-a'), nic('port-b')], (ports) => {
    ports.get('port-a').device_id = '';
    ports.get('port-a').device_owner = '';
  });
  const result = await deleteInstanceWithPorts(session, 'vm-a', {
    request: fixture.request, wait: async () => {}, serverPolls: 2, portPolls: 2,
  });
  assert.equal(result.success, true);
  assert.equal(result.instance_deleted, true);
  assert.equal(result.cleanup.ports_deleted, 1);
  assert.equal(result.cleanup.ports_failed, 1);
  assert.deepEqual(result.cleanup.failed_port_ids, ['port-b']);
  assert.equal(result.warnings[0].reason, 'still_attached');
});

test('foreign server and system Ports never enter deletion', async () => {
  assert.equal(isInstanceNic(nic('system', { device_owner: 'network:router_interface' }), 'vm-a', session), false);
  assert.equal(isInstanceNic(nic('foreign', { project_id: 'project-b' }), 'vm-a', session), false);
  const fixture = provider([]);
  const foreign = { ...session, project: { id: 'project-b' } };
  await assert.rejects(deleteInstanceWithPorts(foreign, 'vm-a', { request: fixture.request }), { status: 404 });
  assert.ok(!fixture.calls.some((call) => call.options.method === 'DELETE'));
});

test('Nova still deleting leaves captured Ports untouched and reports pending cleanup', async () => {
  const fixture = provider([nic('pending-port')]);
  const request = async (currentSession, service, path, options = {}) => {
    if (service === 'compute' && path === '/servers/vm-a' && options.method !== 'DELETE') {
      return { server: server() };
    }
    return fixture.request(currentSession, service, path, options);
  };
  const result = await deleteInstanceWithPorts(session, 'vm-a', {
    request, wait: async () => {}, serverPolls: 2, portPolls: 2,
  });
  assert.equal(result.instance_deleted, false);
  assert.equal(result.cleanup.ports_pending, 1);
  assert.deepEqual(result.warnings, [{ code: 'instance_delete_pending' }]);
  assert.ok(fixture.ports.has('pending-port'));
  assert.ok(!fixture.calls.some((call) => call.service === 'network' && call.options.method === 'DELETE'));
});

test('captured Port whose project or ownership changes is never deleted', async () => {
  const fixture = provider([nic('changed-project'), nic('changed-owner')], (ports) => {
    ports.get('changed-project').project_id = 'project-b';
    ports.get('changed-project').device_id = '';
    ports.get('changed-owner').device_id = '';
    ports.get('changed-owner').device_owner = 'network:router_interface';
  });
  const result = await deleteInstanceWithPorts(session, 'vm-a', {
    request: fixture.request, wait: async () => {}, serverPolls: 2, portPolls: 2,
  });
  assert.deepEqual(result.cleanup.failed_port_ids, ['changed-project', 'changed-owner']);
  assert.ok(fixture.ports.has('changed-project'));
  assert.ok(fixture.ports.has('changed-owner'));
  assert.ok(!fixture.calls.some((call) => call.service === 'network' && call.options.method === 'DELETE'));
});
