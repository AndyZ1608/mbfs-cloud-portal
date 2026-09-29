import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const { mockFetch } = await import('../mock.js');
const { createVip, deleteVip, setVipAssignments, setPortVips, vipAssignments,
  portVips, subnetVips, updateVmPortPairs, hostAddress } = await import('../vip.js');
const session = { project: { id: 'p-demo' }, roles: ['admin'], user: { name: 'vip-test' } };
const direct = (sess, svc, path, options = {}) => mockFetch(svc, options.method || 'GET', path, options.body, sess.project.id);

test('VIP reservation is tagged, disabled, unbound, and never attached to Nova', async () => {
  const subnet = mockFetch('network', 'GET', '/v2.0/subnets', null, 'p-demo').subnets.find((item) => item.project_id === 'p-demo');
  const calls = [];
  const request = (sess, svc, path, options = {}) => {
    calls.push({ svc, path, options });
    return direct(sess, svc, path, options);
  };
  const vip = await createVip(session, subnet.id, { name: 'APP-LB-VIP', ip_address: '10.10.10.100' }, request);
  try {
    const create = calls.find((call) => call.path === '/v2.0/ports' && call.options.method === 'POST');
    assert.deepEqual(create.options.body, { port: {
      name: 'APP-LB-VIP', network_id: subnet.network_id, project_id: 'p-demo', admin_state_up: false,
      port_security_enabled: false, security_groups: [], device_id: '', device_owner: '',
      fixed_ips: [{ subnet_id: subnet.id, ip_address: '10.10.10.100' }],
    } });
    assert.equal(vip.admin_state_up, false);
    assert.equal(vip.port_security_enabled, false);
    assert.deepEqual(vip.security_groups, []);
    assert.deepEqual([vip.device_id, vip.device_owner], ['', '']);
    assert.deepEqual(vip.tags, ['cmp-vip']);
    assert.ok(!calls.some((call) => call.svc === 'compute' && call.options.method === 'POST'));
    assert.ok((await subnetVips(session, subnet.id, request)).vips.some((item) => item.id === vip.id));
    await assert.rejects(createVip({ ...session, project: { id: 'p-devops' } }, subnet.id,
      { name: 'foreign', ip_address: '10.10.10.101' }, request), { status: 404 });
  } finally { await deleteVip(session, vip.id, request); }
});

test('one VIP assigns to multiple VM Ports via AAP-only writes and preserves manual AAP and Port properties', async () => {
  const subnet = mockFetch('network', 'GET', '/v2.0/subnets', null, 'p-demo').subnets.find((item) => item.project_id === 'p-demo');
  const vip = await createVip(session, subnet.id, { name: 'MULTI-VIP', ip_address: '10.10.10.101' }, direct);
  const targets = (await vipAssignments(session, vip.id, direct)).targets;
  assert.ok(targets.length >= 2);
  const [a, b] = targets;
  const liveA = direct(session, 'network', `/v2.0/ports/${a.id}`).port;
  liveA['binding:host_id'] = 'compute-01';
  liveA['binding:vif_type'] = 'ovs';
  liveA['binding:profile'] = { original: 'provider-owned' };
  liveA.qos_policy_id = 'qos-existing';
  const originalA = structuredClone(liveA);
  direct(session, 'network', `/v2.0/ports/${a.id}`, { method: 'PUT', body: { port: {
    allowed_address_pairs: [{ ip_address: '10.10.10.200/32', mac_address: 'fa:16:3e:11:22:33' }],
  } } });
  const writes = [];
  const request = (sess, svc, path, options = {}) => {
    if (svc === 'network' && options.method === 'PUT' && /^\/v2\.0\/ports\/[^/]+$/.test(path)) {
      writes.push({ path, body: structuredClone(options.body) });
    }
    return direct(sess, svc, path, options);
  };
  try {
    const first = await setVipAssignments(session, vip.id, [a.id, b.id], request);
    assert.equal(first.events.length, 2);
    assert.equal(writes.length, 2);
    assert.ok(writes.every((write) => Object.keys(write.body.port).join() === 'allowed_address_pairs'));
    const afterA = direct(session, 'network', `/v2.0/ports/${a.id}`).port;
    for (const key of ['admin_state_up', 'port_security_enabled', 'security_groups', 'fixed_ips',
      'mac_address', 'device_id', 'device_owner', 'network_id', 'name',
      'binding:host_id', 'binding:vif_type', 'binding:profile', 'qos_policy_id']) {
      assert.deepEqual(afterA[key], originalA[key], key);
    }
    assert.deepEqual(afterA.allowed_address_pairs, [
      { ip_address: '10.10.10.200/32', mac_address: 'fa:16:3e:11:22:33' },
      { ip_address: '10.10.10.101/32' },
    ]);
    assert.equal((await subnetVips(session, subnet.id, request)).vips.find((item) => item.id === vip.id).assignment_count, 2);
    assert.equal((await setVipAssignments(session, vip.id, [a.id, b.id], request)).events.length, 0);
    assert.equal(writes.length, 2);
    await assert.rejects(deleteVip(session, vip.id, request), { code: 'vip_delete_assigned', count: 2 });
    const removed = await setVipAssignments(session, vip.id, [b.id], request);
    assert.equal(removed.events.length, 1);
    assert.deepEqual(direct(session, 'network', `/v2.0/ports/${a.id}`).port.allowed_address_pairs,
      [{ ip_address: '10.10.10.200/32', mac_address: 'fa:16:3e:11:22:33' }]);
    assert.equal((await portVips(session, a.id, request)).external_pairs.length, 1);
    assert.ok((await portVips(session, b.id, request)).vips.find((item) => item.id === vip.id).assigned);
    const viaVm = await setPortVips(session, a.id, [vip.id], request);
    assert.equal(viaVm.events[0].action, 'vip.assign');
    const reservation = direct(session, 'network', `/v2.0/ports/${vip.id}`).port;
    assert.equal(reservation.admin_state_up, false);
    assert.equal(reservation.port_security_enabled, false);
    assert.deepEqual(reservation.allowed_address_pairs, []);
    assert.deepEqual([reservation.device_id, reservation.device_owner], ['', '']);
  } finally {
    await setVipAssignments(session, vip.id, [], request);
    await deleteVip(session, vip.id, request);
    direct(session, 'network', `/v2.0/ports/${a.id}`, { method: 'PUT', body: { port: { allowed_address_pairs: [] } } });
    for (const field of ['binding:host_id', 'binding:vif_type', 'binding:profile', 'qos_policy_id']) delete liveA[field];
  }
});

test('foreign and wrong-subnet target Ports are denied before mutation; host forms compare equally', async () => {
  const subnet = mockFetch('network', 'GET', '/v2.0/subnets', null, 'p-demo').subnets.find((item) => item.project_id === 'p-demo');
  const vip = await createVip(session, subnet.id, { name: 'SAFE-VIP', ip_address: '10.10.10.102' }, direct);
  try {
    const wrong = (await vipAssignments(session, vip.id, direct)).targets;
    const otherPort = mockFetch('network', 'GET', '/v2.0/ports', null, 'p-demo').ports
      .find((port) => port.project_id === 'p-demo' && port.fixed_ips?.[0]?.subnet_id !== subnet.id && port.device_owner?.startsWith('compute:'));
    const foreign = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'foreign-vip-net' } }, 'p-devops').network;
    const foreignSubnet = mockFetch('network', 'POST', '/v2.0/subnets', { subnet: { network_id: foreign.id, cidr: '10.99.0.0/24' } }, 'p-devops').subnet;
    await assert.rejects(createVip(session, foreignSubnet.id, { name: 'no', ip_address: '10.99.0.100' }, direct), { status: 404 });
    if (otherPort) await assert.rejects(setVipAssignments(session, vip.id, [otherPort.id], direct), { status: 404 });
    const foreignPort = mockFetch('network', 'POST', '/v2.0/ports', { port: {
      project_id: 'p-devops', network_id: foreign.id, name: 'foreign',
      fixed_ips: [{ subnet_id: foreignSubnet.id, ip_address: '10.99.0.10' }],
      security_groups: [mockFetch('network', 'GET', '/v2.0/security-groups', null, 'p-devops').security_groups.find((g) => g.project_id === 'p-devops' && g.name === 'default').id],
    } }, 'p-devops').port;
    await assert.rejects(setVipAssignments(session, vip.id, [foreignPort.id], direct), { status: 404 });
    assert.equal(hostAddress('10.10.10.102'), hostAddress('10.10.10.102/32'));
    assert.ok(wrong.length >= 1);
  } finally { await deleteVip(session, vip.id, direct); }
});

test('provider AAP rejection and multi-port partial failure never mutate firewall fields or reservation Port', async () => {
  const subnet = mockFetch('network', 'GET', '/v2.0/subnets', null, 'p-demo').subnets.find((item) => item.project_id === 'p-demo');
  const vip = await createVip(session, subnet.id, { name: 'FAILURE-VIP', ip_address: '10.10.10.103' }, direct);
  const [a, b] = (await vipAssignments(session, vip.id, direct)).targets;
  const beforeA = structuredClone(direct(session, 'network', `/v2.0/ports/${a.id}`).port);
  const beforeB = structuredClone(direct(session, 'network', `/v2.0/ports/${b.id}`).port);
  let writes = 0;
  const rejected = (sess, svc, path, options = {}) => {
    if (svc === 'network' && options.method === 'PUT' && path === `/v2.0/ports/${a.id}`) {
      writes++;
      assert.deepEqual(Object.keys(options.body.port), ['allowed_address_pairs']);
      throw Object.assign(new Error('port security policy'), { status: 400 });
    }
    return direct(sess, svc, path, options);
  };
  try {
    await assert.rejects(setVipAssignments(session, vip.id, [a.id], rejected), { code: 'vip_port_rejected' });
    assert.equal(writes, 1);
    assert.deepEqual(direct(session, 'network', `/v2.0/ports/${a.id}`).port, beforeA);
    const partial = (sess, svc, path, options = {}) => {
      if (svc === 'network' && options.method === 'PUT' && path === `/v2.0/ports/${b.id}`) {
        assert.deepEqual(Object.keys(options.body.port), ['allowed_address_pairs']);
        throw Object.assign(new Error('provider rejected second Port'), { status: 400 });
      }
      return direct(sess, svc, path, options);
    };
    await assert.rejects(setVipAssignments(session, vip.id, [a.id, b.id], partial), (error) => {
      assert.equal(error.code, 'vip_partial_failure');
      assert.deepEqual(error.events.map((event) => event.target.id), [a.id]);
      return true;
    });
    assert.equal(hasVip(direct(session, 'network', `/v2.0/ports/${a.id}`).port, vip), true);
    assert.deepEqual(direct(session, 'network', `/v2.0/ports/${b.id}`).port, beforeB);
    for (const key of ['admin_state_up', 'port_security_enabled', 'security_groups', 'fixed_ips', 'mac_address']) {
      assert.deepEqual(direct(session, 'network', `/v2.0/ports/${a.id}`).port[key], beforeA[key], key);
    }
    assert.deepEqual(direct(session, 'network', `/v2.0/ports/${vip.id}`).port.allowed_address_pairs, []);
  } finally {
    await setVipAssignments(session, vip.id, [], direct);
    await deleteVip(session, vip.id, direct);
  }
});

test('same-IP AAP with custom MAC remains manual and is never removed by VIP operations', async () => {
  const subnet = mockFetch('network', 'GET', '/v2.0/subnets', null, 'p-demo').subnets.find((item) => item.project_id === 'p-demo');
  const vip = await createVip(session, subnet.id, { name: 'MANUAL-MAC-VIP', ip_address: '10.10.10.104' }, direct);
  const target = (await vipAssignments(session, vip.id, direct)).targets[0];
  const original = structuredClone(direct(session, 'network', `/v2.0/ports/${target.id}`).port.allowed_address_pairs || []);
  const manual = { ip_address: '10.10.10.104/32', mac_address: 'fa:16:3e:12:34:56' };
  try {
    direct(session, 'network', `/v2.0/ports/${target.id}`, { method: 'PUT', body: { port: { allowed_address_pairs: [...original, manual] } } });
    const view = await portVips(session, target.id, direct);
    assert.equal(view.vips.find((item) => item.id === vip.id).assigned, false);
    assert.deepEqual(view.external_pairs.at(-1), manual);
    await assert.rejects(setPortVips(session, target.id, [vip.id], direct), { code: 'vip_port_rejected' });
    await setPortVips(session, target.id, [], direct);
    assert.deepEqual(direct(session, 'network', `/v2.0/ports/${target.id}`).port.allowed_address_pairs, [...original, manual]);
  } finally {
    direct(session, 'network', `/v2.0/ports/${target.id}`, { method: 'PUT', body: { port: { allowed_address_pairs: original } } });
    await deleteVip(session, vip.id, direct);
  }
});

test('VIP creation fails closed without Port tags and rolls back only its newly created Port on tag failure', async () => {
  const subnet = mockFetch('network', 'GET', '/v2.0/subnets', null, 'p-demo').subnets.find((item) => item.project_id === 'p-demo');
  let posts = 0;
  const noTags = (sess, svc, path, options = {}) => {
    if (path === '/v2.0/extensions') return { extensions: [] };
    if (path === '/v2.0/ports' && options.method === 'POST') posts++;
    return direct(sess, svc, path, options);
  };
  await assert.rejects(createVip(session, subnet.id, { name: 'NO-TAGS', ip_address: '10.10.10.106' }, noTags),
    { code: 'vip_tags_unavailable' });
  assert.equal(posts, 0);
  const before = direct(session, 'network', '/v2.0/ports').ports.map((port) => port.id);
  const tagFailure = (sess, svc, path, options = {}) => {
    if (path.endsWith('/tags/cmp-vip') && options.method === 'PUT') {
      throw Object.assign(new Error('tagging rejected'), { status: 403 });
    }
    return direct(sess, svc, path, options);
  };
  await assert.rejects(createVip(session, subnet.id, { name: 'TAG-FAIL', ip_address: '10.10.10.107' }, tagFailure),
    { code: 'vip_tag_failed' });
  assert.deepEqual(direct(session, 'network', '/v2.0/ports').ports.map((port) => port.id), before);
});

test('a provider-side AAP change is discovered without a CMP assignment record', async () => {
  const subnet = mockFetch('network', 'GET', '/v2.0/subnets', null, 'p-demo').subnets.find((item) => item.project_id === 'p-demo');
  const vip = await createVip(session, subnet.id, { name: 'PROVIDER-VIP', ip_address: '10.10.10.108' }, direct);
  const target = (await vipAssignments(session, vip.id, direct)).targets[0];
  const before = structuredClone(direct(session, 'network', `/v2.0/ports/${target.id}`).port.allowed_address_pairs || []);
  try {
    direct(session, 'network', `/v2.0/ports/${target.id}`, { method: 'PUT', body: { port: {
      allowed_address_pairs: [...before, { ip_address: '10.10.10.108' }],
    } } });
    assert.equal((await vipAssignments(session, vip.id, direct)).targets.find((item) => item.id === target.id).assigned, true);
    assert.equal((await portVips(session, target.id, direct)).vips.find((item) => item.id === vip.id).assigned, true);
    assert.equal((await subnetVips(session, subnet.id, direct)).vips.find((item) => item.id === vip.id).assignment_count, 1);
  } finally {
    direct(session, 'network', `/v2.0/ports/${target.id}`, { method: 'PUT', body: { port: { allowed_address_pairs: before } } });
    await deleteVip(session, vip.id, direct);
  }
});

function hasVip(port, vip) {
  return port.allowed_address_pairs.some((pair) => hostAddress(pair.ip_address) === hostAddress(vip.fixed_ips[0].ip_address));
}
