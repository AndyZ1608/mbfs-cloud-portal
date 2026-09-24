import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const session = { project: { id: 'p-demo' }, user: { name: 'admin' }, roles: ['admin'] };

test('network creation forces DHCP, validates IPv4 gateway, and attaches only routed mode', async () => {
  const { createNetwork, validateNetworkCreate } = await import('../networkCreation.js');
  const calls = [];
  const request = async (_session, service, path, options) => {
    calls.push({ service, path, options });
    if (path === '/v2.0/networks') return { network: { id: 'new-network', project_id: 'p-demo', name: options.body.network.name } };
    if (path === '/v2.0/subnets') return { subnet: { id: 'new-subnet', ...options.body.subnet } };
    return { subnet_id: 'new-subnet' };
  };
  const ownedRouter = async () => ({ id: 'router-own', project_id: 'p-demo' });
  const isolated = await createNetwork(session, {
    name: 'isolated', cidr: '172.30.20.0/24', gateway_ip: '172.30.20.1',
    mode: 'isolated', router_id: 'stale-router', enable_dhcp: false,
  }, { request, ownedRouter: () => { throw Error('isolated must not look up a Router'); } });
  assert.equal(isolated.mode, 'isolated');
  assert.equal(isolated.subnet.enable_dhcp, true);
  assert.equal(isolated.subnet.gateway_ip, '172.30.20.1');
  assert.equal(isolated.router_id, undefined);
  assert.deepEqual(calls.map((call) => call.path), ['/v2.0/networks', '/v2.0/subnets']);

  calls.length = 0;
  const routed = await createNetwork(session, {
    name: 'routed', cidr: '172.30.10.0/24', gateway_ip: '172.30.10.1',
    mode: 'routed', router_id: 'router-own', enable_dhcp: false,
  }, { request, ownedRouter });
  assert.equal(routed.mode, 'routed');
  assert.equal(routed.router_id, 'router-own');
  assert.equal(routed.subnet.enable_dhcp, true);
  assert.deepEqual(calls.map((call) => call.path), [
    '/v2.0/networks', '/v2.0/subnets', '/v2.0/routers/router-own/add_router_interface',
  ]);
  assert.deepEqual(calls[2].options.body, { subnet_id: 'new-subnet' });
  assert.equal(calls[0].options.body.network.project_id, 'p-demo');
  assert.equal(calls[1].options.body.subnet.project_id, 'p-demo');

  assert.throws(() => validateNetworkCreate({ name: 'bad', cidr: '172.30.10.0/24', gateway_ip: '192.168.1.1' }), { code: 'invalid_network_gateway' });
  assert.throws(() => validateNetworkCreate({ name: 'bad', cidr: 'not-a-cidr' }), { code: 'invalid_network_cidr' });
  assert.throws(() => validateNetworkCreate({ name: 'bad', cidr: '172.30.10.0/24', mode: 'routed' }), { code: 'network_router_required' });
  assert.throws(() => validateNetworkCreate(null), { code: 'network_name_cidr_required' });
});

test('subnet failure removes the request-created network without any Router operation', async () => {
  const { createNetwork } = await import('../networkCreation.js');
  const calls = [];
  const request = async (_session, _service, path, options) => {
    calls.push([path, options.method]);
    if (path === '/v2.0/networks' && options.method === 'POST') return { network: { id: 'new-network' } };
    if (path === '/v2.0/subnets' && options.method === 'POST') throw Object.assign(Error('CIDR overlap'), { status: 409 });
    return null;
  };
  await assert.rejects(createNetwork(session, { name: 'test', cidr: '172.30.10.0/24', mode: 'isolated' }, { request }), {
    status: 409, code: 'network_subnet_failed',
  });
  assert.deepEqual(calls, [
    ['/v2.0/networks', 'POST'], ['/v2.0/subnets', 'POST'], ['/v2.0/networks/new-network', 'DELETE'],
  ]);
});

test('router attach failure rolls back only newly created resources and reports partial cleanup', async () => {
  const { createNetwork } = await import('../networkCreation.js');
  const calls = [];
  let failCleanup = false;
  const request = async (_session, _service, path, options) => {
    calls.push([path, options.method]);
    if (path === '/v2.0/networks' && options.method === 'POST') return { network: { id: 'new-network' } };
    if (path === '/v2.0/subnets' && options.method === 'POST') return { subnet: { id: 'new-subnet' } };
    if (path.endsWith('/add_router_interface')) throw Object.assign(Error('conflict'), { status: 409 });
    if (failCleanup && options.method === 'DELETE') throw Object.assign(Error('cleanup failed'), { status: 503 });
    return null;
  };
  const input = { name: 'routed', cidr: '172.30.10.0/24', mode: 'routed', router_id: 'router-own' };
  const options = { request, ownedRouter: async () => ({ id: 'router-own' }) };
  await assert.rejects(createNetwork(session, input, options), { status: 409, code: 'network_router_attach_failed' });
  assert.deepEqual(calls.slice(-3), [
    ['/v2.0/routers/router-own/remove_router_interface', 'PUT'],
    ['/v2.0/subnets/new-subnet', 'DELETE'], ['/v2.0/networks/new-network', 'DELETE'],
  ]);
  assert.ok(calls.every(([path]) => !path.includes('pre-existing')));

  calls.length = 0;
  failCleanup = true;
  await assert.rejects(createNetwork(session, input, options), (error) => {
    assert.equal(error.code, 'network_partial_failure');
    assert.deepEqual(error.resourceIds, { networkId: 'new-network', subnetId: 'new-subnet' });
    return true;
  });
});

test('HTTP create uses current-project Router, rejects foreign or missing Router before mutations', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const foreign = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'foreign-router' } }, 'p-devops').router;
  const app = createApp({ sessionStore: null, sessionSecret: 'network-mode-security-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const request = (path, cookie, method = 'GET', body) => fetch(base + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { 'X-CMP-Request': '1', 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = await request('/auth/login', null, 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const routers = (await (await request('/routers', cookie)).json()).routers;
  assert.ok(routers.length);
  assert.ok(!routers.some((router) => router.id === foreign.id));
  const before = mockFetch('network', 'GET', '/v2.0/networks').networks.length;
  const body = { name: 'new-routed', cidr: '172.30.10.0/24', gateway_ip: '172.30.10.1', mode: 'routed', enable_dhcp: false };
  assert.equal((await request('/networks', cookie, 'POST', body)).status, 400);
  assert.equal((await request('/networks', cookie, 'POST', { ...body, router_id: foreign.id })).status, 404);
  assert.equal(mockFetch('network', 'GET', '/v2.0/networks').networks.length, before);

  const routedResponse = await request('/networks', cookie, 'POST', { ...body, router_id: routers[0].id });
  assert.equal(routedResponse.status, 200);
  const routed = await routedResponse.json();
  assert.equal(routed.mode, 'routed');
  assert.equal(routed.subnet.enable_dhcp, true);
  assert.equal(routed.subnet.gateway_ip, body.gateway_ip);
  const routerPorts = mockFetch('network', 'GET', `/v2.0/ports?device_id=${routers[0].id}`).ports;
  assert.ok(routerPorts.some((port) => port.fixed_ips?.some((ip) => ip.subnet_id === routed.subnet.id)));

  const foreignPortsBefore = mockFetch('network', 'GET', `/v2.0/ports?device_id=${foreign.id}`).ports.length;
  const isolatedResponse = await request('/networks', cookie, 'POST', {
    ...body, name: 'new-isolated', cidr: '172.30.20.0/24', gateway_ip: '172.30.20.1',
    mode: 'isolated', router_id: foreign.id,
  });
  assert.equal(isolatedResponse.status, 200);
  const isolated = await isolatedResponse.json();
  assert.equal(isolated.mode, 'isolated');
  assert.equal(isolated.subnet.enable_dhcp, true);
  assert.equal(isolated.subnet.gateway_ip, '172.30.20.1');
  assert.equal(mockFetch('network', 'GET', `/v2.0/ports?device_id=${foreign.id}`).ports.length, foreignPortsBefore);
  assert.ok(!mockFetch('network', 'GET', `/v2.0/ports?device_id=${routers[0].id}`).ports.some((port) => port.fixed_ips?.some((ip) => ip.subnet_id === isolated.subnet.id)));
});
