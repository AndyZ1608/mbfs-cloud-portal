import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('ownership normalization fails closed for absent or conflicting project IDs', async () => {
  const { isOwned, owned, assertOwned, resourceProjectId } = await import('../projectScope.js');
  const sess = { project: { id: 'project-a' }, roles: ['admin'] };
  const rows = [
    { id: 'A', project_id: 'project-a' },
    { id: 'B', tenant_id: 'project-b' },
    { id: 'C', project_id: 'project-c' },
    { id: 'unknown' },
    { id: 'conflict', project_id: 'project-a', tenant_id: 'project-b' },
  ];
  assert.deepEqual(owned(rows, sess).map((row) => row.id), ['A']);
  assert.equal(resourceProjectId({ 'os-vol-tenant-attr:tenant_id': 'project-a' }), 'project-a');
  assert.equal(resourceProjectId({ 'os-extended-snapshot-attributes:project_id': 'project-a' }), 'project-a');
  assert.equal(isOwned(rows[4], sess), false);
  assert.throws(() => assertOwned(rows[1], sess), { status: 404, code: 'resource_not_found' });
});

test('admin visibility cannot cross the selected CMP project boundary', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');

  const networkB = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'BACKUP-private' } }, 'p-devops').network;
  const networkC = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'NTS-private' } }, 'p-nts').network;
  const sharedB = mockFetch('network', 'POST', '/v2.0/networks', { network: { name: 'BACKUP-shared' } }, 'p-devops').network;
  sharedB.shared = true;
  const routerB = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'BACKUP-router' } }, 'p-devops').router;
  const routerC = mockFetch('network', 'POST', '/v2.0/routers', { router: { name: 'NTS-router' } }, 'p-nts').router;
  const sgB = mockFetch('network', 'POST', '/v2.0/security-groups', { security_group: { name: 'BACKUP-sg' } }, 'p-devops').security_group;
  const volumeB = mockFetch('volume', 'POST', '/volumes', { volume: { name: 'BACKUP-volume', size: 1 } }, 'p-devops').volume;
  const snapshotB = mockFetch('volume', 'POST', '/snapshots', { snapshot: { name: 'BACKUP-snapshot', volume_id: volumeB.id } }, 'p-devops').snapshot;
  const serverB = mockFetch('compute', 'POST', '/servers', { server: { name: 'BACKUP-vm', flavorRef: 'f-small', networks: [{ uuid: networkB.id }] } }, 'p-devops').server;
  const lbB = mockFetch('lb', 'POST', '/v2/lbaas/loadbalancers', { loadbalancer: { name: 'BACKUP-lb', vip_subnet_id: 'subnet-b', listeners: [] } }, 'p-devops').loadbalancer;
  const imageB = mockFetch('image', 'POST', '/v2/images', { name: 'BACKUP-private-image', disk_format: 'qcow2', visibility: 'private' }, 'p-devops');

  const app = createApp({ sessionStore: null, sessionSecret: 'project-isolation-security-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, cookie, method = 'GET', body) => fetch(base + `/api${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-CMP-Request': '1', 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = async (path, cookie) => {
    const response = await request(path, cookie);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const login = await request('/auth/login', null, 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  assert.ok((await login.json()).roles.includes('admin'));
  const serverA = (await read('/servers', cookie)).servers[0];
  assert.ok(serverA);
  assert.equal((await read(`/servers/${serverA.id}`, cookie)).server.id, serverA.id);
  assert.ok(Array.isArray((await read(`/servers/${serverA.id}/activity`, cookie)).entries));
  assert.ok(Array.isArray((await read(`/servers/${serverA.id}/interfaces`, cookie)).interfaces));
  assert.ok(Array.isArray((await read(`/servers/${serverA.id}/volumes`, cookie)).volumeAttachments));
  const availableVolume = (await read('/volumes', cookie)).volumes.find((volume) => volume.status === 'available');
  assert.ok(availableVolume);
  assert.equal((await request(`/volumes/${availableVolume.id}/attach`, cookie, 'POST', { server_id: serverA.id })).status, 200);
  assert.ok((await read(`/servers/${serverA.id}/activity`, cookie)).entries.some((event) => event.action === 'instance.volume.attach'));
  // The mock completes Nova/Cinder volume attachment asynchronously.
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = (await read('/volumes', cookie)).volumes.find((volume) => volume.id === availableVolume.id);
    if (current.attachments?.some((attachment) => attachment.server_id === serverA.id)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const snapshot = await request('/snapshots', cookie, 'POST', { volume_id: availableVolume.id, name: 'vm-audit-snapshot' });
  assert.equal(snapshot.status, 200);
  await snapshot.json();
  assert.ok((await read(`/servers/${serverA.id}/activity`, cookie)).entries.some((event) => event.action === 'instance.snapshot.create'));
  const detach = await request(`/volumes/${availableVolume.id}/detach`, cookie, 'POST', { server_id: serverA.id });
  assert.equal(detach.status, 200);
  await detach.json();
  assert.ok((await read(`/servers/${serverA.id}/activity`, cookie)).entries.some((event) =>
    event.action === 'instance.volume.detach' && event.details.volume_id === availableVolume.id));

  const networksA = (await read('/networks', cookie)).networks;
  assert.ok(networksA.length > 0);
  assert.ok(networksA.every((network) => network.project_id === 'p-demo'));
  assert.ok(!networksA.some((network) => [networkB.id, networkC.id, sharedB.id].includes(network.id)));
  const routersA = (await read('/routers', cookie)).routers;
  assert.ok(routersA.length > 0);
  assert.ok(routersA.every((router) => router.project_id === 'p-demo'));
  assert.ok(!routersA.some((router) => [routerB.id, routerC.id].includes(router.id)));
  const available = (await read('/available-networks', cookie)).networks;
  assert.ok(available.some((network) => network.id === sharedB.id));
  assert.ok(!available.some((network) => [networkB.id, networkC.id].includes(network.id)));
  assert.ok(!(await read('/external-networks', cookie)).networks.some((network) => network.id === sharedB.id));
  assert.ok(!(await read('/images', cookie)).images.some((image) => image.id === imageB.id));

  for (const [path, id] of [
    ['/servers', serverB.id], ['/volumes', volumeB.id], ['/snapshots', snapshotB.id], ['/security-groups', sgB.id], ['/lb', lbB.id],
  ]) {
    const result = await read(path, cookie);
    const rows = result.servers || result.volumes || result.snapshots || result.security_groups || result.loadbalancers;
    assert.ok(Array.isArray(rows) && !rows.some((row) => row.id === id), `${path} leaked ${id}`);
  }
  for (const path of [
    `/networks/${networkB.id}`, `/routers/${routerB.id}`, `/servers/${serverB.id}`,
    `/servers/${serverB.id}/activity`, `/servers/${serverB.id}/interfaces`, `/servers/${serverB.id}/volumes`,
    `/lb/${lbB.id}/tree`,
  ]) assert.equal((await request(path, cookie)).status, 404, path);
  for (const path of [`/networks/${networkB.id}`, `/routers/${routerB.id}`, `/servers/${serverB.id}`, `/volumes/${volumeB.id}`, `/security-groups/${sgB.id}`]) {
    assert.equal((await request(path, cookie, 'DELETE')).status, 404, path);
  }
  assert.equal((await request(`/volumes/${volumeB.id}/attach`, cookie, 'POST', { server_id: serverB.id })).status, 404);
  assert.equal((await request('/security-group-rules', cookie, 'POST', { security_group_id: sgB.id, direction: 'ingress' })).status, 404);
  assert.equal((await request('/backup/policies', cookie, 'POST', { type: 'server', target_id: serverB.id })).status, 404);
  assert.equal((await request('/power/rules', cookie, 'POST', { server_id: serverB.id, action: 'stop' })).status, 404);
  assert.equal((await request('/servers', cookie, 'POST', { name: 'forbidden-image', flavorRef: 'f-small', imageRef: imageB.id, networks: [networksA[0].id] })).status, 404);
  const terraform = await request('/export/terraform', cookie);
  assert.equal(terraform.status, 200);
  const exported = await terraform.text();
  for (const forbidden of ['BACKUP-private', 'BACKUP-router', 'BACKUP-sg', 'BACKUP-volume', 'BACKUP-vm']) {
    assert.ok(!exported.includes(forbidden), `Terraform leaked ${forbidden}`);
  }
  assert.equal(mockFetch('network', 'GET', `/v2.0/networks/${networkB.id}`).network.name, 'BACKUP-private');
  assert.equal(mockFetch('network', 'GET', `/v2.0/routers/${routerB.id}`).router.name, 'BACKUP-router');

  const created = await request('/networks', cookie, 'POST', { name: 'XPLAT-new', cidr: '10.77.0.0/24', project_id: 'p-devops' });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).network.project_id, 'p-demo');

  const switchResponse = await request('/auth/switch-project', cookie, 'POST', { projectId: 'p-devops' });
  assert.equal(switchResponse.status, 200);
  if (switchResponse.headers.get('set-cookie')) cookie = switchResponse.headers.get('set-cookie').split(';')[0];
  const networksAfter = (await read('/networks', cookie)).networks;
  assert.ok(networksAfter.some((network) => network.id === networkB.id));
  assert.ok(networksAfter.every((network) => network.project_id === 'p-devops'));
  assert.ok((await read('/routers', cookie)).routers.some((router) => router.id === routerB.id));
  assert.ok(!(await read('/servers', cookie)).servers.some((server) => server.project_id === 'p-demo' || server.tenant_id === 'p-demo'));
  assert.equal((await request(`/servers/${serverA.id}`, cookie)).status, 404);
  assert.equal((await request(`/servers/${serverA.id}/activity`, cookie)).status, 404);
  assert.equal((await request(`/networks/${networksA[0].id}`, cookie)).status, 404);

  const member = await request('/auth/login', null, 'POST', { username: 'member', password: 'demo' });
  const memberCookie = member.headers.get('set-cookie').split(';')[0];
  assert.ok((await read('/networks', memberCookie)).networks.every((network) => network.project_id === 'p-demo'));
});
