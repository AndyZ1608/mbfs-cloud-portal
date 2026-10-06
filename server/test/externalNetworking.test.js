import test from 'node:test';
import assert from 'node:assert/strict';
import { OSError } from '../openstack.js';
import { normalizeNetworkingConfig } from '../config.js';
import { allocateConfiguredFloatingIp, assertPortExternalPath, configuredExternalNetwork,
  createConfiguredRouter, inFloatingIpPool } from '../externalNetworking.js';

const EXT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUB_B1 = '11111111-1111-4111-8111-111111111111';
const SUB_B2 = '22222222-2222-4222-8222-222222222222';
const networking = normalizeNetworkingConfig({ external_network_id: EXT_B, floating_ip_subnet_id: SUB_B2 });
const session = (id = 'project-a') => ({ project: { id }, roles: ['admin'] });
const subnets = {
  [SUB_B1]: { id: SUB_B1, network_id: EXT_B, ip_version: 4, cidr: '198.51.100.0/24',
    allocation_pools: [{ start: '198.51.100.20', end: '198.51.100.99' }] },
  [SUB_B2]: { id: SUB_B2, network_id: EXT_B, ip_version: 4, cidr: '203.0.113.0/24',
    allocation_pools: [{ start: '203.0.113.20', end: '203.0.113.99' }] },
};

function provider({ external = true, address = '203.0.113.20', gateway = EXT_B,
  failAllocation = null, foreignPort = false } = {}) {
  const calls = [];
  const routers = new Map();
  const networks = new Map([EXT_A, EXT_B, EXT_C].map((id) => [id, {
    id, 'router:external': id === EXT_B ? external : true,
  }]));
  const request = async (sess, service, path, options = {}) => {
    assert.equal(service, 'network');
    calls.push({ project: sess.project.id, path, options });
    if (path.startsWith('/v2.0/networks/') && !options.method) return { network: networks.get(path.split('/').at(-1)) };
    if (path.startsWith('/v2.0/subnets/') && !options.method) return { subnet: subnets[path.split('/').at(-1)] };
    if (path === '/v2.0/routers' && options.method === 'POST') {
      const router = { id: `router-${routers.size + 1}`, project_id: sess.project.id,
        name: options.body.router.name, external_gateway_info: { network_id: gateway } };
      routers.set(router.id, router);
      return { router };
    }
    if (path.startsWith('/v2.0/routers/') && !options.method) return { router: routers.get(path.split('/').at(-1)) };
    if (path.startsWith('/v2.0/routers/') && options.method === 'DELETE') {
      routers.delete(path.split('/').at(-1)); return null;
    }
    if (path.startsWith('/v2.0/ports/') && !options.method) {
      return { port: { id: path.split('/').at(-1), project_id: foreignPort ? 'project-b' : sess.project.id,
        network_id: 'tenant-net', fixed_ips: [{ subnet_id: 'tenant-sub', ip_address: '10.0.0.10' }] } };
    }
    if (path.startsWith('/v2.0/ports?')) return { ports: [] };
    if (path === '/v2.0/floatingips' && options.method === 'POST') {
      if (failAllocation) throw failAllocation;
      return { floatingip: { id: 'fip-1', project_id: sess.project.id, floating_network_id: EXT_B,
        subnet_id: SUB_B2, floating_ip_address: address } };
    }
    if (path === '/v2.0/floatingips/fip-1' && options.method === 'DELETE') return null;
    throw new Error(`Unexpected provider request ${path}`);
  };
  return { request, calls, routers };
}

test('networking configuration requires paired, well-formed UUIDs', () => {
  assert.deepEqual(networking.errors, []);
  assert.equal(normalizeNetworkingConfig({ external_network_id: EXT_B }).errors.length, 1);
  assert.equal(normalizeNetworkingConfig({ external_network_id: 'public', floating_ip_subnet_id: SUB_B2 }).errors.length, 1);
});

test('new Routers for either selected project use only configured EXT-B and verify the gateway', async () => {
  const fixture = provider();
  for (const projectId of ['project-a', 'project-b']) {
    const result = await createConfiguredRouter(session(projectId), 'HQS-Router', { request: fixture.request, networking });
    assert.equal(result.router.project_id, projectId);
    assert.equal(result.router.external_gateway_info.network_id, EXT_B);
  }
  const creates = fixture.calls.filter((call) => call.options.method === 'POST');
  assert.equal(creates.length, 2);
  for (const call of creates) {
    assert.equal(call.options.body.router.project_id, call.project);
    assert.equal(call.options.body.router.external_gateway_info.network_id, EXT_B);
    assert.equal(call.options.body.router.admin_state_up, true);
  }
  assert.ok(!fixture.calls.some((call) => call.path.includes(EXT_A) || call.path.includes(EXT_C)));
});

test('missing or non-external configured network rejects before Router create', async () => {
  for (const options of [{ networking: normalizeNetworkingConfig() }, { networking }]) {
    const fixture = provider({ external: false });
    await assert.rejects(createConfiguredRouter(session(), 'Router', { ...options, request: fixture.request }),
      (error) => ['external_network_unconfigured', 'external_network_invalid'].includes(error.code));
    assert.ok(!fixture.calls.some((call) => call.options.method === 'POST'));
  }
});

test('gateway verification failure rolls back only the newly created empty Router', async () => {
  const fixture = provider({ gateway: EXT_A });
  await assert.rejects(createConfiguredRouter(session(), 'Broken', { request: fixture.request, networking }),
    { code: 'router_gateway_failed' });
  assert.equal(fixture.routers.size, 0);
  assert.deepEqual(fixture.calls.filter((call) => call.options.method === 'DELETE').map((call) => call.path),
    ['/v2.0/routers/router-1']);
});

test('FIP uses configured EXT-B/SUB-B2 pool even when other networks and subnets exist', async () => {
  const fixture = provider();
  const result = await allocateConfiguredFloatingIp(session(), { request: fixture.request, networking });
  assert.equal(result.floatingip.floating_ip_address, '203.0.113.20');
  const create = fixture.calls.find((call) => call.path === '/v2.0/floatingips');
  assert.deepEqual(create.options.body.floatingip, { floating_network_id: EXT_B, subnet_id: SUB_B2,
    project_id: 'project-a' });
  assert.equal(inFloatingIpPool('198.51.100.20', subnets[SUB_B2]), false);
  assert.equal(inFloatingIpPool('203.0.113.19', subnets[SUB_B2]), false);
  assert.equal(inFloatingIpPool('203.0.113.99', subnets[SUB_B2]), true);
  assert.equal(inFloatingIpPool('203.0.113.100', subnets[SUB_B2]), false);
});

test('pool exhaustion never retries another network or subnet', async () => {
  const fixture = provider({ failAllocation: new OSError(409, 'No available IP addresses') });
  await assert.rejects(allocateConfiguredFloatingIp(session(), { request: fixture.request, networking }),
    { code: 'floating_ip_pool_exhausted' });
  assert.equal(fixture.calls.filter((call) => call.options.method === 'POST').length, 1);
});

test('Neutron quota failure remains a project-scoped allocation error', async () => {
  const fixture = provider({ failAllocation: new OSError(409, 'Quota exceeded for floatingip') });
  await assert.rejects(allocateConfiguredFloatingIp(session(), { request: fixture.request, networking }),
    { code: 'floating_ip_quota_exceeded' });
  assert.equal(fixture.calls.filter((call) => call.options.method === 'POST').length, 1);
});

test('out-of-pool provider response is deleted instead of presented as a valid FIP', async () => {
  const fixture = provider({ address: '198.51.100.25' });
  await assert.rejects(allocateConfiguredFloatingIp(session(), { request: fixture.request, networking }),
    { code: 'floating_ip_range_mismatch' });
  assert.ok(fixture.calls.some((call) => call.path === '/v2.0/floatingips/fip-1' && call.options.method === 'DELETE'));
});

test('foreign project Port cannot be used for FIP allocation, including with admin role', async () => {
  const fixture = provider({ foreignPort: true });
  await assert.rejects(allocateConfiguredFloatingIp(session(), { request: fixture.request, networking, portId: 'foreign' }),
    { code: 'resource_not_found' });
  assert.ok(!fixture.calls.some((call) => call.options.method === 'POST'));
});

test('association path requires a current-project Router to the selected external network', async () => {
  const port = { project_id: 'project-a', network_id: 'tenant-net', fixed_ips: [{ subnet_id: 'tenant-sub' }] };
  const calls = [];
  const request = async (_session, _service, path) => {
    calls.push(path);
    if (path.startsWith('/v2.0/ports?')) return { ports: [{ id: 'iface', project_id: 'project-a',
      device_owner: 'network:router_interface', device_id: 'router-1',
      fixed_ips: [{ subnet_id: 'tenant-sub' }] }] };
    if (path === '/v2.0/routers/router-1') return { router: { project_id: 'project-a',
      external_gateway_info: { network_id: EXT_B } } };
    throw new Error(path);
  };
  await assertPortExternalPath(session(), port, EXT_B, request);
  await assert.rejects(assertPortExternalPath(session(), port, EXT_A, request), { code: 'floating_ip_no_route' });
  assert.ok(calls.every((path) => !path.includes('project-b')));
});
