import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const { mockFetch } = await import('../mock.js');
const { editNetwork, loadNetworkEdit } = await import('../networkEdit.js');
const session = { project: { id: 'p-demo' } };
const requestLog = [];
const request = (sess, service, path, options = {}) => {
  requestLog.push({ method: options.method || 'GET', path, body: options.body });
  return mockFetch(service, options.method || 'GET', path, options.body, sess.project.id);
};
const inputFrom = (state) => ({
  name: state.network.name, revision_number: state.network.revision_number,
  subnets: state.subnets.map((subnet) => ({
    id: subnet.id, revision_number: subnet.revision_number, name: subnet.name || '',
    gateway_ip: subnet.gateway_ip ?? null, dns_nameservers: subnet.dns_nameservers || [],
    allocation_pools: subnet.allocation_pools || [], mode: subnet.mode, router_id: subnet.router_id,
  })),
});

test('edits only changed UUID-addressed resources and preserves multiple subnets', async (t) => {
  const network = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'edit-test' } }, 'p-demo').network;
  const first = mockFetch('network', 'POST', '/v2.0/subnets', { subnet: {
    network_id: network.id, name: 'first', cidr: '10.50.0.0/24', gateway_ip: '10.50.0.1', dns_nameservers: ['8.8.8.8'],
  } }, 'p-demo').subnet;
  const second = mockFetch('network', 'POST', '/v2.0/subnets', { subnet: {
    network_id: network.id, name: 'second', cidr: '10.51.0.0/24', gateway_ip: '10.51.0.1',
  } }, 'p-demo').subnet;
  const a = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'edit-router-a' } }, 'p-demo').router;
  const b = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'edit-router-b' } }, 'p-demo').router;
  t.after(() => {
    for (const router of [a, b]) {
      const port = mockFetch('network', 'GET', `/v2.0/ports?device_id=${router.id}`, null, 'p-demo').ports;
      for (const item of port) mockFetch('network', 'PUT', `/v2.0/routers/${router.id}/remove_router_interface`, { subnet_id: item.fixed_ips[0].subnet_id }, 'p-demo');
      mockFetch('network', 'DELETE', `/v2.0/routers/${router.id}`, null, 'p-demo');
    }
    mockFetch('network', 'DELETE', `/v2.0/networks/${network.id}`, null, 'p-demo');
  });
  const initial = await loadNetworkEdit(session, network.id, request);
  assert.deepEqual(initial.subnets.map((subnet) => subnet.mode), ['isolated', 'isolated']);
  requestLog.length = 0;
  await editNetwork(session, network.id, inputFrom(initial), request);
  assert.equal(requestLog.filter((call) => call.method === 'PUT').length, 0);

  let input = inputFrom(await loadNetworkEdit(session, network.id, request));
  input.name = 'edit-test-renamed';
  requestLog.length = 0;
  const rename = await editNetwork(session, network.id, input, async (...args) => {
    const value = request(...args);
    return args[3]?.method === 'PUT' ? null : value; // Neutron may return a successful empty 2xx body.
  });
  assert.deepEqual(requestLog.filter((call) => call.method === 'PUT').map((call) => call.path), [`/v2.0/networks/${network.id}`]);
  assert.equal(rename.events[0].action, 'network.rename');

  input = inputFrom(await loadNetworkEdit(session, network.id, request));
  input.subnets[0].name = 'first-renamed';
  input.subnets[0].gateway_ip = '10.50.0.254';
  input.subnets[0].dns_nameservers = ['1.1.1.1', '8.8.8.8'];
  input.subnets[0].allocation_pools = [{ start: '10.50.0.100', end: '10.50.0.200' }];
  requestLog.length = 0;
  const updated = await editNetwork(session, network.id, input, request);
  assert.deepEqual(requestLog.filter((call) => call.method === 'PUT').map((call) => call.path), [`/v2.0/subnets/${first.id}`]);
  assert.equal(updated.subnets.find((subnet) => subnet.id === second.id).name, 'second');
  assert.deepEqual(updated.events.map((event) => event.action), ['subnet.update', 'subnet.gateway.update', 'subnet.dns.update', 'subnet.allocation_pool.update']);
  const reordered = inputFrom(await loadNetworkEdit(session, network.id, request));
  reordered.subnets[0].allocation_pools = [{ end: '10.50.0.200', start: '10.50.0.100' }];
  requestLog.length = 0;
  await editNetwork(session, network.id, reordered, request);
  assert.equal(requestLog.filter((call) => call.method === 'PUT').length, 0);

  input = inputFrom(await loadNetworkEdit(session, network.id, request));
  input.subnets[0].mode = 'routed'; input.subnets[0].router_id = a.id;
  requestLog.length = 0;
  await editNetwork(session, network.id, input, request);
  assert.deepEqual(requestLog.filter((call) => call.method === 'PUT').map((call) => call.path), [`/v2.0/routers/${a.id}/add_router_interface`]);
  assert.equal((await loadNetworkEdit(session, network.id, request)).subnets[0].router_id, a.id);
  requestLog.length = 0;
  await editNetwork(session, network.id, input, request);
  assert.equal(requestLog.filter((call) => call.method === 'PUT').length, 0);

  input = inputFrom(await loadNetworkEdit(session, network.id, request));
  input.subnets[0].router_id = b.id;
  requestLog.length = 0;
  await editNetwork(session, network.id, input, request);
  assert.deepEqual(requestLog.filter((call) => call.method === 'PUT').map((call) => call.path), [
    `/v2.0/routers/${a.id}/remove_router_interface`, `/v2.0/routers/${b.id}/add_router_interface`,
  ]);
  input = inputFrom(await loadNetworkEdit(session, network.id, request));
  input.subnets[0].mode = 'isolated'; input.subnets[0].router_id = null;
  await editNetwork(session, network.id, input, request);
  assert.equal((await loadNetworkEdit(session, network.id, request)).subnets[0].mode, 'isolated');
  assert.equal(mockFetch('network', 'GET', `/v2.0/subnets/${first.id}`, null, 'p-demo').subnet.id, first.id);
});

test('rejects immutable fields and foreign resources before any mutation', async (t) => {
  const network = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'guarded' } }, 'p-demo').network;
  const subnet = mockFetch('network', 'POST', '/v2.0/subnets', { subnet: { network_id: network.id, cidr: '10.60.0.0/24' } }, 'p-demo').subnet;
  const foreign = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'foreign' } }, 'p-devops').router;
  t.after(() => {
    mockFetch('network', 'DELETE', `/v2.0/routers/${foreign.id}`, null, 'p-devops');
    mockFetch('network', 'DELETE', `/v2.0/networks/${network.id}`, null, 'p-demo');
  });
  const state = await loadNetworkEdit(session, network.id, request);
  for (const extra of [{ cidr: '10.70.0.0/24' }, { ip_version: 6 }, { enable_dhcp: false }, { project_id: 'p-devops' }]) {
    const input = inputFrom(state);
    Object.assign(input.subnets[0], extra);
    requestLog.length = 0;
    await assert.rejects(editNetwork(session, network.id, input, request), { status: 400 });
    assert.equal(requestLog.filter((call) => call.method === 'PUT').length, 0);
  }
  for (const mutate of [
    (input) => { input.subnets[0].gateway_ip = '10.90.0.1'; },
    (input) => { input.subnets[0].dns_nameservers = ['not-an-ip']; },
    (input) => { input.subnets[0].allocation_pools = [{ start: '10.60.0.200', end: '10.60.0.100' }]; },
  ]) {
    const input = inputFrom(state); mutate(input);
    requestLog.length = 0;
    await assert.rejects(editNetwork(session, network.id, input, request), { status: 400 });
    assert.equal(requestLog.filter((call) => call.method === 'PUT').length, 0);
  }
  const foreignInput = inputFrom(state);
  foreignInput.subnets[0].mode = 'routed'; foreignInput.subnets[0].router_id = foreign.id;
  requestLog.length = 0;
  await assert.rejects(editNetwork(session, network.id, foreignInput, request), { status: 404 });
  assert.equal(requestLog.filter((call) => call.method === 'PUT').length, 0);
  await assert.rejects(editNetwork({ project: { id: 'p-devops' } }, network.id, inputFrom(state), request), { status: 404 });
  const otherShared = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'shared-foreign' } }, 'p-devops').network;
  otherShared.shared = true;
  await assert.rejects(loadNetworkEdit(session, otherShared.id, request), { status: 404 });
  mockFetch('network', 'DELETE', `/v2.0/networks/${otherShared.id}`, null, 'p-devops');
  assert.equal(mockFetch('network', 'GET', `/v2.0/subnets/${subnet.id}`, null, 'p-demo').subnet.enable_dhcp, true);
  subnet.enable_dhcp = false;
  const legacy = inputFrom(await loadNetworkEdit(session, network.id, request));
  legacy.subnets[0].name = 'legacy-renamed';
  await editNetwork(session, network.id, legacy, request);
  assert.equal(subnet.enable_dhcp, false);
});

test('router move restores original attachment and name when new attach fails', async (t) => {
  const network = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'rollback-test' } }, 'p-demo').network;
  const subnet = mockFetch('network', 'POST', '/v2.0/subnets', { subnet: { network_id: network.id, cidr: '10.70.0.0/24' } }, 'p-demo').subnet;
  const a = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'rollback-a' } }, 'p-demo').router;
  const b = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'rollback-b' } }, 'p-demo').router;
  mockFetch('network', 'PUT', `/v2.0/routers/${a.id}/add_router_interface`, { subnet_id: subnet.id }, 'p-demo');
  t.after(() => {
    const attached = mockFetch('network', 'GET', `/v2.0/ports?network_id=${network.id}`, null, 'p-demo').ports;
    for (const port of attached) mockFetch('network', 'PUT', `/v2.0/routers/${port.device_id}/remove_router_interface`, { subnet_id: subnet.id }, 'p-demo');
    for (const router of [a, b]) mockFetch('network', 'DELETE', `/v2.0/routers/${router.id}`, null, 'p-demo');
    mockFetch('network', 'DELETE', `/v2.0/networks/${network.id}`, null, 'p-demo');
  });
  const input = inputFrom(await loadNetworkEdit(session, network.id, request));
  input.name = 'rename-that-must-rollback';
  input.subnets[0].router_id = b.id;
  const failingRequest = (sess, service, path, options = {}) => {
    if (path === `/v2.0/routers/${b.id}/add_router_interface`) throw Object.assign(new Error('simulated Neutron conflict'), { status: 409 });
    return request(sess, service, path, options);
  };
  await assert.rejects(editNetwork(session, network.id, input, failingRequest), { code: 'network_edit_routing_failed' });
  const restored = await loadNetworkEdit(session, network.id, request);
  assert.equal(restored.network.name, 'rollback-test');
  assert.equal(restored.subnets[0].router_id, a.id);
  const retry = inputFrom(restored);
  retry.subnets[0].router_id = b.id;
  const failedRollback = (sess, service, path, options = {}) => {
    if (path.endsWith('/add_router_interface')) throw Object.assign(new Error('simulated Neutron failure'), { status: 409 });
    return request(sess, service, path, options);
  };
  await assert.rejects(editNetwork(session, network.id, retry, failedRollback), {
    code: 'network_edit_partial_failure', resourceIds: { networkId: network.id, subnetId: subnet.id },
  });
});

test('an ambiguous provider timeout reports partial failure rather than claiming rollback', async (t) => {
  const network = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'timeout-edit' } }, 'p-demo').network;
  t.after(() => mockFetch('network', 'DELETE', `/v2.0/networks/${network.id}`, null, 'p-demo'));
  const input = inputFrom(await loadNetworkEdit(session, network.id, request));
  input.name = 'timeout-may-have-committed';
  const timeout = (sess, service, path, options = {}) => {
    const result = request(sess, service, path, options);
    if (options.method === 'PUT') throw Object.assign(new Error('timeout'), { status: 504 });
    return result;
  };
  await assert.rejects(editNetwork(session, network.id, input, timeout), { code: 'network_edit_partial_failure' });
});

test('HTTP edit route is project-scoped and emits semantic network audit', async (t) => {
  const { createApp } = await import('../app.js');
  const { listAudit } = await import('../audit.js');
  const network = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'http-edit' } }, 'p-demo').network;
  mockFetch('network', 'POST', '/v2.0/subnets', { subnet: { network_id: network.id, cidr: '10.80.0.0/24' } }, 'p-demo');
  const foreign = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'foreign-http-edit' } }, 'p-devops').network;
  t.after(() => {
    mockFetch('network', 'DELETE', `/v2.0/networks/${network.id}`, null, 'p-demo');
    mockFetch('network', 'DELETE', `/v2.0/networks/${foreign.id}`, null, 'p-devops');
  });
  const app = createApp({ sessionStore: null, sessionSecret: 'network-edit-http-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'X-CMP-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const read = (id) => fetch(`${base}/networks/${id}/edit`, { headers: { Cookie: cookie } });
  const patch = (id, body) => fetch(`${base}/networks/${id}`, {
    method: 'PATCH', headers: { Cookie: cookie, 'X-CMP-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const initial = await read(network.id);
  assert.equal(initial.status, 200);
  const data = await initial.json();
  assert.equal(data.subnets.length, 1);
  const input = inputFrom(data);
  input.name = 'http-edit-renamed';
  const updated = await patch(network.id, input);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).network.name, input.name);
  assert.ok(listAudit({ projectId: 'p-demo', user: 'admin', limit: 20 }).some((entry) =>
    entry.action === 'network.rename' && entry.resource_id === network.id
    && entry.details.old_name === 'http-edit' && entry.details.new_name === input.name));
  assert.equal((await read(foreign.id)).status, 404);
  assert.equal((await patch(foreign.id, input)).status, 404);
  assert.equal(mockFetch('network', 'GET', `/v2.0/networks/${foreign.id}`, null, 'p-devops').network.name, 'foreign-http-edit');
});
