import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('CMP VM mutations produce semantic, scoped audit records retained after deletion', async (t) => {
  const { createApp } = await import('../app.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'semantic-audit-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie = '';
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { 'X-CMP-Request': '1', 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = async (path) => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const login = await request('/auth/login', 'POST', { username: 'semantic-audit-test', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const image = (await read('/images')).images[0];
  const network = (await read('/available-networks')).networks.find((item) => item.project_id === 'p-demo' && item.subnet_details?.length);
  const originalName = 'audit-vm';
  const create = await request('/servers', 'POST', { name: originalName, flavorRef: 'f-small', imageRef: image.id,
    interfaces: [{ network_id: network.id, subnet_id: network.subnet_details[0].id, ip_address: null }],
    user_data: '#cloud-config\nwrite_files:\n- content: PRIVATE-CLOUD-INIT-SECRET' });
  assert.equal(create.status, 202);
  const id = (await create.json()).server.id;
  const renamed = 'audit-vm-renamed';
  assert.equal((await request(`/servers/${id}`, 'PUT', { name: renamed })).status, 200);
  for (const action of ['stop', 'start', 'reboot-soft', 'reboot-hard', 'snapshot', 'shelve', 'unshelve']) {
    const response = await request(`/servers/${id}/action`, 'POST', { action, ...(action === 'snapshot' ? { name: 'audit-snapshot' } : {}) });
    assert.equal(response.status, 200, action);
  }
  assert.equal((await request(`/servers/${id}/security-groups`, 'POST', { add: ['web-server'], remove: [] })).status, 200);
  const fip = (await read('/floatingips')).floatingips.find((item) => !item.port_id);
  assert.ok(fip);
  assert.equal((await request(`/floatingips/${fip.id}/associate`, 'POST', { server_id: id })).status, 200);
  assert.equal((await request(`/floatingips/${fip.id}/disassociate`, 'POST')).status, 200);

  const activity = await read(`/servers/${id}/activity?limit=2`);
  assert.equal(activity.entries.length, 2);
  assert.equal(activity.next_offset, 2);
  assert.ok((await read(`/servers/${id}/activity?limit=20`)).entries.some((event) => event.action === 'instance.create'));

  const deletion = await request(`/servers/${id}`, 'DELETE');
  assert.equal(deletion.status, 200);
  assert.equal((await request(`/servers/${id}/activity`)).status, 404);
  const global = (await read('/audit?limit=100')).entries.filter((entry) => entry.resource_id === id);
  const codes = global.map((entry) => entry.action);
  for (const code of ['instance.create', 'instance.rename', 'instance.stop', 'instance.start',
    'instance.reboot.soft', 'instance.reboot.hard', 'instance.snapshot.create',
    'instance.security_groups.change', 'instance.floating_ip.associate',
    'instance.floating_ip.disassociate', 'instance.shelve', 'instance.unshelve', 'instance.delete']) {
    assert.ok(codes.includes(code), code);
  }
  assert.ok(!codes.includes('instance.action'));
  const created = global.find((entry) => entry.action === 'instance.create');
  assert.equal(created.resource_name, originalName);
  assert.equal(created.resource_id, id);
  assert.equal(created.project_id, 'p-demo');
  assert.equal(created.result, 'accepted');
  assert.equal(created.details.image_id, image.id);
  const rename = global.find((entry) => entry.action === 'instance.rename');
  assert.deepEqual(rename.details, { old_name: originalName, new_name: renamed });
  const removed = global.find((entry) => entry.action === 'instance.delete');
  assert.equal(removed.resource_name, renamed);
  assert.equal(removed.resource_id, id);
  assert.equal(removed.project_id, 'p-demo');
  assert.equal(removed.result, 'accepted');
  assert.equal(JSON.stringify(global).includes('PRIVATE-CLOUD-INIT-SECRET'), false);

  const switchProject = await request('/auth/switch-project', 'POST', { projectId: 'p-devops' });
  assert.equal(switchProject.status, 200);
  if (switchProject.headers.get('set-cookie')) cookie = switchProject.headers.get('set-cookie').split(';')[0];
  assert.ok(!(await read('/audit?limit=100')).entries.some((entry) => entry.resource_id === id));
});
