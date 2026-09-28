import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('VM error APIs are project-scoped and never return raw Nova fault data', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'error-diagnostics-http-test' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie = '';
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { 'X-CMP-Request': '1', 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = await request('/auth/login', 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const server = mockFetch('compute', 'GET', '/servers/detail', null, 'p-demo').servers.find((item) => item.tenant_id === 'p-demo');
  assert.ok(server);
  const original = { status: server.status, fault: server.fault };
  t.after(() => { server.status = original.status; server.fault = original.fault; });
  const secret = 'password=NOT-FOR-CUSTOMER token=PRIVATE-KEY Traceback 10.1.2.3';
  server.status = 'ERROR';
  server.fault = { message: `NoValidHost: ${secret}`, details: secret, created: '2026-09-20T09:30:00Z' };

  for (const path of ['/servers', `/servers/${server.id}`, `/servers/${server.id}/error`]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    const payload = await response.text();
    assert.equal(payload.includes(secret), false, path);
    assert.equal(payload.includes('"fault":'), false, path);
    assert.match(payload, /NO_VALID_HOST/, path);
  }
  const event = (await (await request(`/servers/${server.id}/activity`)).json()).entries
    .find((entry) => entry.action === 'instance.error.detected');
  assert.ok(event);
  assert.equal(event.details.error_code, 'NO_VALID_HOST');
  assert.equal(JSON.stringify(event).includes(secret), false);
  await request(`/servers/${server.id}/error`);
  const events = (await (await request(`/servers/${server.id}/activity`)).json()).entries
    .filter((entry) => entry.action === 'instance.error.detected' && entry.details.occurred_at === '2026-09-20T09:30:00.000Z');
  assert.equal(events.length, 1);
  server.status = 'ACTIVE';
  assert.deepEqual(await (await request(`/servers/${server.id}/error`)).json(), { error: null });
  assert.equal((await (await request(`/servers/${server.id}`)).json()).server.instance_error, undefined);

  const switched = await request('/auth/switch-project', 'POST', { projectId: 'p-devops' });
  assert.equal(switched.status, 200);
  if (switched.headers.get('set-cookie')) cookie = switched.headers.get('set-cookie').split(';')[0];
  for (const path of [`/servers/${server.id}`, `/servers/${server.id}/error`, `/servers/${server.id}/activity`]) {
    assert.equal((await request(path)).status, 404, path);
  }
});

test('create request rejects known image requirements before Nova submission', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'image-preflight-http-test' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie = '';
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { 'X-CMP-Request': '1', 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = await request('/auth/login', 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const image = (await (await request('/images')).json()).images[0];
  const providerImage = mockFetch('image', 'GET', `/v2/images/${image.id}`, null, 'p-demo');
  const old = { min_disk: providerImage.min_disk, min_ram: providerImage.min_ram };
  t.after(() => { providerImage.min_disk = old.min_disk; providerImage.min_ram = old.min_ram; });
  const count = mockFetch('compute', 'GET', '/servers/detail', null, 'p-demo').servers.length;
  providerImage.min_disk = 80;
  const disk = await request('/servers', 'POST', { name: 'should-not-build', flavorRef: 'f-medium', imageRef: image.id });
  assert.equal(disk.status, 400);
  assert.deepEqual((await disk.json()).context, { required_disk_gb: 80, flavor_disk_gb: 40 });
  assert.equal(mockFetch('compute', 'GET', '/servers/detail', null, 'p-demo').servers.length, count);
  const network = (await (await request('/available-networks')).json()).networks
    .find((item) => item.project_id === 'p-demo' && item.subnet_details?.length);
  const volumeBoot = await request('/servers', 'POST', { name: 'valid-volume-boot', flavorRef: 'f-small', imageRef: image.id,
    boot_volume_gb: 80, interfaces: [{ network_id: network.id, subnet_id: network.subnet_details[0].id, ip_address: null }] });
  assert.equal(volumeBoot.status, 202);
  const volumeBootId = (await volumeBoot.json()).server.id;
  mockFetch('compute', 'DELETE', `/servers/${volumeBootId}`, null, 'p-demo');
  providerImage.min_ram = 8192;
  const ram = await request('/servers', 'POST', { name: 'should-not-build', flavorRef: 'f-small', imageRef: image.id, boot_volume_gb: 80 });
  assert.equal(ram.status, 400);
  assert.deepEqual((await ram.json()).context, { required_ram_mb: 8192, flavor_ram_mb: 2048 });
  assert.equal(mockFetch('compute', 'GET', '/servers/detail', null, 'p-demo').servers.length, count);
});
