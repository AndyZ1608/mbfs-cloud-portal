import test from 'node:test';
import assert from 'node:assert/strict';
import { OSError } from '../openstack.js';
import { allocateDiscoveredFloatingIp, createDiscoveredRouter, discoverExternalNetwork,
  discoverFloatingIpSubnet, inFloatingIpPool, portExternalPath } from '../externalNetworking.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const sess = (id = 'project-a') => ({ project: { id }, roles: ['admin'] });
const external = (id, extra = {}) => ({ id, project_id: 'infrastructure', shared: true,
  'router:external': true, admin_state_up: true, ...extra });
const subnet = (id, networkId, cidr, start, end, extra = {}) => ({ id, network_id: networkId,
  ip_version: 4, cidr, allocation_pools: [{ start, end }], ...extra });

function fixture({ networks = [external(A), external(B, { is_default: true }), external(C)],
  subnets = [subnet(S1, B, '198.51.100.0/24', '198.51.100.20', '198.51.100.99'),
    subnet(S2, B, '203.0.113.0/24', '203.0.113.20', '203.0.113.99', { service_types: ['network:floatingip'] })],
  responseAddress = '203.0.113.20', responsePort = undefined, gateway = null,
  allocationError = null, foreignPort = false,
  policies = [] } = {}) {
  const calls = [];
  const routers = new Map([['tenant-router', { id: 'tenant-router', project_id: 'project-a',
    external_gateway_info: { network_id: B } }]]);
  const port = { id: 'vm-port', project_id: foreignPort ? 'project-b' : 'project-a',
    device_id: 'vm-a', device_owner: 'compute:nova', network_id: 'tenant-net',
    fixed_ips: [{ subnet_id: 'tenant-sub', ip_address: '10.0.0.10' }] };
  const iface = { id: 'router-iface', project_id: 'project-a', network_id: 'tenant-net',
    device_owner: 'network:router_interface', device_id: 'tenant-router',
    fixed_ips: [{ subnet_id: 'tenant-sub', ip_address: '10.0.0.1' }] };
  const request = async (session, service, path, options = {}) => {
    assert.equal(service, 'network');
    calls.push({ project: session.project.id, path, options });
    if (path === '/v2.0/networks?router:external=true') return { networks };
    if (path.startsWith('/v2.0/networks/')) return { network: networks.find((item) => item.id === path.split('/').at(-1)) };
    if (path.startsWith('/v2.0/rbac-policies?')) return { rbac_policies: policies };
    if (path.startsWith('/v2.0/subnets?')) return { subnets: subnets.filter((item) => item.network_id === new URLSearchParams(path.split('?')[1]).get('network_id')) };
    if (path === '/v2.0/routers' && options.method === 'POST') {
      const router = { id: `created-${routers.size}`, project_id: session.project.id,
        name: options.body.router.name, external_gateway_info: { network_id: gateway || options.body.router.external_gateway_info.network_id } };
      routers.set(router.id, router);
      return { router };
    }
    if (path.startsWith('/v2.0/routers/') && options.method === 'DELETE') {
      routers.delete(path.split('/').at(-1)); return null;
    }
    if (path.startsWith('/v2.0/routers/')) return { router: routers.get(path.split('/').at(-1)) };
    if (path.startsWith('/v2.0/ports/')) return { port };
    if (path.startsWith('/v2.0/ports?')) return { ports: path.includes('device_id=created-') ? [] : [port, iface] };
    if (path === '/v2.0/floatingips' && options.method === 'POST') {
      if (allocationError) throw allocationError;
      return { floatingip: { id: 'fip-1', project_id: session.project.id,
        floating_network_id: options.body.floatingip.floating_network_id,
        subnet_id: options.body.floatingip.subnet_id, floating_ip_address: responseAddress,
        port_id: responsePort === undefined ? options.body.floatingip.port_id || null : responsePort } };
    }
    if (path === '/v2.0/floatingips/fip-1' && options.method === 'DELETE') return null;
    throw new Error(`Unexpected request ${path}`);
  };
  return { request, calls, routers, port };
}

test('one available Neutron External Network works without any YAML IDs', async () => {
  const f = fixture({ networks: [external(B)] });
  const created = await createDiscoveredRouter(sess(), 'HQS-Router', { request: f.request });
  assert.equal(created.router.external_gateway_info.network_id, B);
  assert.deepEqual(f.calls.find((call) => call.options.method === 'POST').options.body.router,
    { name: 'HQS-Router', project_id: 'project-a', admin_state_up: true, external_gateway_info: { network_id: B } });
  const fip = await allocateDiscoveredFloatingIp(sess(), { request: f.request });
  assert.equal(fip.floatingip.floating_network_id, B);
  assert.equal(fip.floatingip.subnet_id, S2);
});

test('zero and disabled External Networks reject before Router creation', async () => {
  for (const networks of [[], [external(B, { admin_state_up: false })], [external(B, { 'router:external': false })]]) {
    const f = fixture({ networks });
    await assert.rejects(createDiscoveredRouter(sess(), 'No gateway', { request: f.request }),
      { code: 'external_network_unavailable' });
    assert.ok(!f.calls.some((call) => call.options.method === 'POST'));
  }
});

test('Neutron is_default wins; otherwise stable ID ordering ignores API response order', async () => {
  for (const networks of [[external(C), external(B, { is_default: true }), external(A)],
    [external(A), external(C), external(B, { is_default: true })]]) {
    assert.equal((await discoverExternalNetwork(sess(), { request: fixture({ networks }).request })).id, B);
  }
  for (const networks of [[external(C), external(B), external(A)], [external(A), external(C), external(B)]]) {
    assert.equal((await discoverExternalNetwork(sess(), { request: fixture({ networks }).request })).id, A);
  }
});

test('admin-visible foreign private network needs current-project external RBAC', async () => {
  const networks = [external(A, { shared: false }), external(B, { shared: true })];
  assert.equal((await discoverExternalNetwork(sess(), { request: fixture({ networks }).request })).id, B);
  const policies = [{ object_type: 'network', object_id: A, action: 'access_as_external', target_tenant: 'project-a' }];
  assert.equal((await discoverExternalNetwork(sess(), { request: fixture({ networks, policies }).request })).id, A);
});

test('gateway verification failure rolls back only the just-created empty Router', async () => {
  const f = fixture({ networks: [external(B)], gateway: A });
  await assert.rejects(createDiscoveredRouter(sess(), 'Broken', { request: f.request }),
    { code: 'router_gateway_failed' });
  assert.equal(f.routers.size, 1);
  assert.ok(f.routers.has('tenant-router'));
});

test('subnet selection prefers explicit Floating IP service type, then stable ID', async () => {
  const f = fixture();
  assert.equal((await discoverFloatingIpSubnet(sess(), B, { request: f.request })).id, S2);
  const plain = fixture({ subnets: [
    subnet(S2, B, '203.0.113.0/24', '203.0.113.20', '203.0.113.99'),
    subnet(S1, B, '198.51.100.0/24', '198.51.100.20', '198.51.100.99'),
  ] });
  assert.equal((await discoverFloatingIpSubnet(sess(), B, { request: plain.request })).id, S1);
  assert.equal(inFloatingIpPool('203.0.113.20',
    subnet(S2, B, '203.0.113.0/24', '203.0.113.20', '203.0.113.99')), true);
});

test('missing or service-only external Subnet never triggers allocation on another network', async () => {
  for (const subnets of [[], [subnet(S1, B, '198.51.100.0/24', '198.51.100.20', '198.51.100.99',
    { service_types: ['network:router_gateway'] })]]) {
    const f = fixture({ subnets });
    await assert.rejects(allocateDiscoveredFloatingIp(sess(), { request: f.request }),
      { code: 'floating_ip_subnet_unavailable' });
    assert.ok(!f.calls.some((call) => call.options.method === 'POST'));
  }
});

test('targeted FIP follows current-project VM Router path rather than the global default', async () => {
  const f = fixture({ networks: [external(A, { is_default: true }), external(B)] });
  assert.equal((await portExternalPath(sess(), f.port, { request: f.request })).networkId, B);
  const result = await allocateDiscoveredFloatingIp(sess(), { portId: 'vm-port', request: f.request });
  assert.equal(result.floatingip.floating_network_id, B);
  assert.equal(f.calls.find((call) => call.path === '/v2.0/floatingips').options.body.floatingip.subnet_id, S2);
});

test('pool exhaustion and quota do not fall back to another network or subnet', async () => {
  for (const [message, code] of [['No available IP addresses', 'floating_ip_pool_exhausted'],
    ['Quota exceeded for floatingip', 'floating_ip_quota_exceeded']]) {
    const f = fixture({ allocationError: new OSError(409, message) });
    await assert.rejects(allocateDiscoveredFloatingIp(sess(), { request: f.request }), { code });
    assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, 1);
  }
});

test('foreign Port and out-of-pool provider response are rejected', async () => {
  const foreign = fixture({ foreignPort: true });
  await assert.rejects(allocateDiscoveredFloatingIp(sess(), { portId: 'vm-port', request: foreign.request }),
    { code: 'resource_not_found' });
  assert.ok(!foreign.calls.some((call) => call.options.method === 'POST'));
  const wrong = fixture({ responseAddress: '198.51.100.25' });
  await assert.rejects(allocateDiscoveredFloatingIp(sess(), { request: wrong.request }),
    { code: 'floating_ip_range_mismatch' });
  assert.ok(wrong.calls.some((call) => call.path === '/v2.0/floatingips/fip-1' && call.options.method === 'DELETE'));
});

test('targeted allocation rejects a provider response that did not attach the requested Port', async () => {
  const f = fixture({ responsePort: null });
  await assert.rejects(allocateDiscoveredFloatingIp(sess(), { portId: 'vm-port', request: f.request }),
    { code: 'floating_ip_target_mismatch' });
  assert.ok(f.calls.some((call) => call.path === '/v2.0/floatingips/fip-1' && call.options.method === 'DELETE'));
});
