import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const { mockFetch } = await import('../mock.js');
const { OSError } = await import('../openstack.js');
const { prepareInterfaces, createServerWithInterfaces, attachInterface, rollbackInterfacePorts } = await import('../instanceInterfaces.js');

const session = (projectId) => ({ project: { id: projectId }, user: { name: 'test' }, roles: ['admin'] });
let serial = 0;
function fixture(projectId = 'p-demo') {
  serial += 1;
  const network = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: `nic-test-${serial}` } }, projectId).network;
  const subnet = mockFetch('network', 'POST', '/v2.0/subnets', { subnet: {
    network_id: network.id, cidr: `10.${90 + serial}.0.0/24`, gateway_ip: `10.${90 + serial}.0.1`,
  } }, projectId).subnet;
  return { network, subnet, spec: { network_id: network.id, subnet_id: subnet.id, ip_address: null } };
}
const direct = (sess, svc, path, options = {}) => mockFetch(svc, options.method || 'GET', path, options.body, sess.project.id);
const portsFor = (sess) => mockFetch('network', 'GET', '/v2.0/ports', null, sess.project.id).ports.filter((port) => port.project_id === sess.project.id);

test('auto and fixed IP create separate Neutron ports with current-project default SG; Nova receives only port UUIDs', async () => {
  const sess = session('p-demo');
  const a = fixture();
  const b = fixture();
  const fixed = `10.${90 + serial}.0.50`;
  const prepared = await prepareInterfaces(sess, [a.spec, { ...b.spec, ip_address: fixed }]);
  const defaultSg = mockFetch('network', 'GET', '/v2.0/security-groups', null, 'p-demo').security_groups.find((group) => group.project_id === 'p-demo' && group.name === 'default');
  assert.equal(prepared.defaultGroupId, defaultSg.id);
  const calls = [];
  const request = (s, svc, path, opts = {}) => {
    calls.push({ svc, path, body: opts.body });
    if (svc === 'compute' && path === '/servers') return { server: { id: 'new-vm' } };
    return direct(s, svc, path, opts);
  };
  const { ports } = await createServerWithInterfaces(sess, { name: 'new-vm', flavorRef: 'f-small' }, prepared, { request });
  try {
    assert.equal(ports.length, 2);
    const posts = calls.filter((call) => call.svc === 'network' && call.path === '/v2.0/ports');
    assert.deepEqual(posts[0].body.port.fixed_ips, [{ subnet_id: a.subnet.id }]);
    assert.deepEqual(posts[1].body.port.fixed_ips, [{ subnet_id: b.subnet.id, ip_address: fixed }]);
    assert.deepEqual(posts.map((call) => call.body.port.name), ['new-vm-nic0', 'new-vm-nic1']);
    assert.ok(posts.every((call) => call.body.port.project_id === 'p-demo'
      && call.body.port.security_groups.length === 1 && call.body.port.security_groups[0] === defaultSg.id));
    assert.deepEqual(calls.find((call) => call.svc === 'compute').body.server.networks, ports.map((port) => ({ port: port.id })));
    assert.equal(ports[1].fixed_ips[0].ip_address, fixed);
    assert.ok(ports[0].fixed_ips[0].ip_address);
  } finally { await rollbackInterfacePorts(sess, ports, direct); }
});

test('project isolation and subnet/IP validation happen before any port mutation', async () => {
  const sess = session('p-demo');
  const own = fixture();
  const foreign = fixture('p-devops');
  const other = fixture();
  let posts = 0;
  const request = (s, svc, path, opts = {}) => {
    if (svc === 'network' && path === '/v2.0/ports' && opts.method === 'POST') posts++;
    return direct(s, svc, path, opts);
  };
  await assert.rejects(prepareInterfaces(sess, [foreign.spec], { request }), { status: 404, code: 'resource_not_found' });
  await assert.rejects(prepareInterfaces(sess, [{ ...own.spec, subnet_id: other.subnet.id }], { request }), { code: 'interface_subnet_mismatch' });
  await assert.rejects(prepareInterfaces(sess, [{ ...own.spec, ip_address: own.subnet.gateway_ip }], { request }), { code: 'interface_invalid_ip' });
  await assert.rejects(prepareInterfaces(sess, [{ ...own.spec, ip_address: `10.${90 + serial - 2}.0.0` }], { request }), { code: 'interface_invalid_ip' });
  await assert.rejects(prepareInterfaces(sess, [{ ...own.spec, ip_address: 'not-an-ip' }], { request }), { code: 'interface_invalid_ip' });
  await assert.rejects(prepareInterfaces(sess, [{ ...own.spec, ip_address: '10.255.255.2' }], { request }), { code: 'interface_invalid_ip' });
  await assert.rejects(prepareInterfaces(sess, [{ ...own.spec, ip_address: '10.90.0.50' }, { ...own.spec, ip_address: '10.90.0.50' }], { request }), { code: 'interface_duplicate_ip' });
  assert.equal(posts, 0);
});

test('default SG is resolved separately for each selected project', async () => {
  const a = fixture('p-demo');
  const b = fixture('p-devops');
  const first = await prepareInterfaces(session('p-demo'), [a.spec]);
  const second = await prepareInterfaces(session('p-devops'), [b.spec]);
  assert.notEqual(first.defaultGroupId, second.defaultGroupId);
  const all = mockFetch('network', 'GET', '/v2.0/security-groups', null, 'p-demo').security_groups;
  assert.equal(all.find((group) => group.id === first.defaultGroupId).project_id, 'p-demo');
  assert.equal(all.find((group) => group.id === second.defaultGroupId).project_id, 'p-devops');
});

test('missing project default SG stops before port creation', async () => {
  const sess = session('p-demo');
  const { spec } = fixture();
  let posts = 0;
  const request = (s, svc, path, opts = {}) => {
    if (svc === 'network' && path.startsWith('/v2.0/security-groups')) return { security_groups: [] };
    if (svc === 'network' && path === '/v2.0/ports' && opts.method === 'POST') posts++;
    return direct(s, svc, path, opts);
  };
  await assert.rejects(prepareInterfaces(sess, [spec], { request }), { code: 'interface_default_sg_missing' });
  assert.equal(posts, 0);
});

test('second port failure and Nova failure roll back only request-created ports', async () => {
  const sess = session('p-demo');
  const a = fixture();
  const b = fixture();
  const prepared = await prepareInterfaces(sess, [a.spec, b.spec]);
  const before = new Set(portsFor(sess).map((port) => port.id));
  let portPosts = 0;
  let novaCalls = 0;
  const failSecond = (s, svc, path, opts = {}) => {
    if (svc === 'network' && path === '/v2.0/ports' && opts.method === 'POST' && ++portPosts === 2) {
      throw new OSError(409, 'IP address already allocated');
    }
    if (svc === 'compute' && path === '/servers') novaCalls++;
    return direct(s, svc, path, opts);
  };
  await assert.rejects(createServerWithInterfaces(sess, { name: 'fail-port' }, prepared, { request: failSecond }), { code: 'interface_ip_in_use' });
  assert.equal(novaCalls, 0);
  assert.deepEqual(new Set(portsFor(sess).map((port) => port.id)), before);
  const failNova = (s, svc, path, opts = {}) => {
    if (svc === 'compute' && path === '/servers') throw new OSError(500, 'Nova failure');
    return direct(s, svc, path, opts);
  };
  await assert.rejects(createServerWithInterfaces(sess, { name: 'fail-nova' }, prepared, { request: failNova }), { code: 'interface_server_create_failed' });
  assert.deepEqual(new Set(portsFor(sess).map((port) => port.id)), before);
});

test('existing VM attach uses the same port helper and removes its port if Nova attach fails', async () => {
  const sess = session('p-demo');
  const { spec } = fixture();
  const before = new Set(portsFor(sess).map((port) => port.id));
  let attachment;
  const request = (s, svc, path, opts = {}) => {
    if (svc === 'compute' && path.endsWith('/os-interface')) {
      attachment = opts.body.interfaceAttachment;
      return { interfaceAttachment: attachment };
    }
    return direct(s, svc, path, opts);
  };
  const { port } = await attachInterface(sess, 'vm-existing', spec, { request });
  assert.deepEqual(attachment, { port_id: port.id });
  assert.equal(port.security_groups.length, 1);
  await rollbackInterfacePorts(sess, [port], direct);
  const failAttach = (s, svc, path, opts = {}) => {
    if (svc === 'compute' && path.endsWith('/os-interface')) throw new OSError(409, 'attach failed');
    return direct(s, svc, path, opts);
  };
  await assert.rejects(attachInterface(sess, 'vm-existing', spec, { request: failAttach }), { code: 'interface_attach_failed' });
  assert.deepEqual(new Set(portsFor(sess).map((item) => item.id)), before);
});

test('failed cleanup reports partial failure and retains operator-identifiable port', async () => {
  const sess = session('p-demo');
  const { spec } = fixture();
  const prepared = await prepareInterfaces(sess, [spec]);
  let created;
  const request = (s, svc, path, opts = {}) => {
    if (svc === 'compute' && path === '/servers') throw new OSError(500, 'Nova failure');
    if (svc === 'network' && path.startsWith('/v2.0/ports/') && opts.method === 'DELETE') throw new OSError(500, 'cleanup failed');
    const result = direct(s, svc, path, opts);
    if (svc === 'network' && path === '/v2.0/ports' && opts.method === 'POST') created = result.port;
    return result;
  };
  await assert.rejects(createServerWithInterfaces(sess, { name: 'cleanup-fails' }, prepared, { request }), { code: 'interface_partial_failure' });
  assert.ok(portsFor(sess).some((port) => port.id === created.id));
  await rollbackInterfacePorts(sess, [created], direct);
});

test('ambiguous Nova responses never report success or delete possibly attached ports', async () => {
  const sess = session('p-demo');
  const { spec } = fixture();
  const prepared = await prepareInterfaces(sess, [spec]);
  const before = new Set(portsFor(sess).map((port) => port.id));
  const noResponse = (s, svc, path, opts = {}) => svc === 'compute' ? null : direct(s, svc, path, opts);
  await assert.rejects(createServerWithInterfaces(sess, { name: 'unknown-create' }, prepared, { request: noResponse }), { code: 'interface_partial_failure' });
  await assert.rejects(attachInterface(sess, 'vm-existing', spec, { request: noResponse }), { code: 'interface_partial_failure' });
  const uncertain = portsFor(sess).filter((port) => !before.has(port.id));
  assert.equal(uncertain.length, 2);
  await rollbackInterfacePorts(sess, uncertain, direct);
});
