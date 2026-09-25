import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('HTTP VM create and existing-VM attach use scoped Neutron ports; foreign networks are rejected', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const { listAudit } = await import('../audit.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'instance-interface-http-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie = '';
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-CMP-Request': '1', 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = await request('/auth/login', 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const networks = (await (await request('/available-networks')).json()).networks.filter((network) => network.project_id === 'p-demo');
  const image = (await (await request('/images')).json()).images[0];
  const [a, b] = networks.filter((network) => network.subnet_details?.length).slice(0, 2);
  assert.ok(a && b);
  const fixed = '10.10.10.60';
  const interfaces = [
    { network_id: a.id, subnet_id: a.subnet_details[0].id, ip_address: a.name === 'net-internal' ? fixed : null },
    { network_id: b.id, subnet_id: b.subnet_details[0].id, ip_address: b.name === 'net-internal' ? fixed : null },
  ];
  const foreign = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'foreign-private' } }, 'p-devops').network;
  const foreignSubnet = mockFetch('network', 'POST', '/v2.0/subnets', { subnet: { network_id: foreign.id, cidr: '10.200.0.0/24' } }, 'p-devops').subnet;
  const payload = { name: 'port-first-http', flavorRef: 'f-small', imageRef: image.id, interfaces };
  const forbidden = await request('/servers', 'POST', { ...payload, interfaces: [{ network_id: foreign.id, subnet_id: foreignSubnet.id, ip_address: null }] });
  assert.equal(forbidden.status, 404);
  const created = await request('/servers', 'POST', payload);
  assert.equal(created.status, 202);
  const id = (await created.json()).server.id;
  const createAudit = listAudit({ projectId: 'p-demo', user: 'admin', limit: 30 })
    .find((entry) => entry.action === 'instance.create' && entry.resource_id === id);
  assert.equal(createAudit.result, 'accepted');
  assert.equal(createAudit.resource_name, payload.name);
  assert.equal(createAudit.project_id, 'p-demo');
  assert.equal(createAudit.details.interface_count, 2);
  t.after(() => mockFetch('compute', 'DELETE', `/servers/${id}`, null, 'p-demo'));
  const attached = (await (await request(`/servers/${id}/interfaces`)).json()).interfaces;
  assert.equal(attached.length, 2);
  const defaultSg = mockFetch('network', 'GET', '/v2.0/security-groups', null, 'p-demo').security_groups.find((group) => group.project_id === 'p-demo' && group.name === 'default');
  assert.ok(attached.every((port) => port.project_id === 'p-demo' && port.device_id === id && port.security_groups[0] === defaultSg.id));
  assert.ok(attached.some((port) => port.fixed_ips[0].ip_address === fixed));
  const portCount = mockFetch('network', 'GET', '/v2.0/ports', null, 'p-demo').ports.length;
  const duplicate = await request('/servers', 'POST', { ...payload, name: 'duplicate-ip', interfaces: [
    { network_id: b.id, subnet_id: b.subnet_details[0].id, ip_address: null },
    { network_id: a.id, subnet_id: a.subnet_details[0].id, ip_address: a.name === 'net-internal' ? fixed : null },
  ] });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'interface_ip_in_use');
  assert.equal(mockFetch('network', 'GET', '/v2.0/ports', null, 'p-demo').ports.length, portCount);
  assert.equal((await request('/servers', 'POST', { ...payload, interfaces: undefined, networks: [a.id] })).status, 400);
  const repeatedFixed = await request('/servers', 'POST', { ...payload, count: 2 });
  assert.equal(repeatedFixed.status, 400);
  assert.equal((await repeatedFixed.json()).code, 'interface_batch_fixed_ip');
  assert.equal(mockFetch('network', 'GET', '/v2.0/ports', null, 'p-demo').ports.length, portCount);
  const batch = await request('/servers', 'POST', { ...payload, name: 'batch-auto', count: 2, interfaces: [{ ...interfaces[1], ip_address: null }] });
  assert.equal(batch.status, 202);
  const batchServers = (await batch.json()).servers;
  assert.equal(batchServers.length, 2);
  assert.notEqual(batchServers[0].id, batchServers[1].id);
  const batchAudit = listAudit({ projectId: 'p-demo', user: 'admin', limit: 30 })
    .filter((entry) => entry.action === 'instance.create' && batchServers.some((server) => server.id === entry.resource_id));
  assert.equal(batchAudit.length, 2);
  for (const server of batchServers) {
    const serverPorts = mockFetch('network', 'GET', `/v2.0/ports?device_id=${server.id}`, null, 'p-demo').ports;
    assert.equal(serverPorts.length, 1);
    t.after(() => mockFetch('compute', 'DELETE', `/servers/${server.id}`, null, 'p-demo'));
  }

  const existing = (await (await request('/servers')).json()).servers.find((server) => server.id !== id && (server.project_id === 'p-demo' || server.tenant_id === 'p-demo'));
  assert.ok(existing);
  const add = await request(`/servers/${existing.id}/interfaces`, 'POST', { network_id: b.id, subnet_id: b.subnet_details[0].id, ip_address: null });
  assert.equal(add.status, 200);
  const portId = (await add.json()).interfaceAttachment.port_id;
  const attachAudit = listAudit({ projectId: 'p-demo', user: 'admin', limit: 10 })
    .find((entry) => entry.action === 'instance.interface.attach' && entry.resource_id === existing.id);
  assert.equal(attachAudit.details.port_id, portId);
  assert.equal(attachAudit.details.network_id, b.id);
  const port = mockFetch('network', 'GET', `/v2.0/ports/${portId}`, null, 'p-demo').port;
  assert.equal(port.device_id, existing.id);
  assert.deepEqual(port.security_groups, [defaultSg.id]);
  const detach = await request(`/servers/${existing.id}/interfaces/${portId}`, 'DELETE');
  assert.equal(detach.status, 200);
  await detach.json();
  assert.ok(listAudit({ projectId: 'p-demo', user: 'admin', limit: 10 })
    .some((entry) => entry.action === 'instance.interface.detach' && entry.details?.port_id === portId));
  assert.equal(mockFetch('network', 'GET', `/v2.0/ports/${portId}`, null, 'p-demo').port.device_id, '');
  mockFetch('network', 'DELETE', `/v2.0/ports/${portId}`, null, 'p-demo');
});
