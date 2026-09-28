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

  const image = (await (await request('/images')).json()).images[0];
  const supportId = 'req-4579b8e7-19d4-44b5-9627-542f5ea7e8ad';
  const hostile = 'Traceback File "/var/lib/kolla/venv/lib/python3.12/site-packages/nova/compute.py" '
    + 'nova.exception.InvalidBDM cinderclient.exceptions.BadRequest password=SUPER_SECRET '
    + 'X-Auth-Token: SECRET_TOKEN rabbit://user:pass@internal-rabbit/ internal-compute-host.example';
  server.status = 'ERROR';
  server.fault = { code: 500, created: '2026-09-28T07:31:35Z',
    message: `BuildAbortException: InvalidBDM: Image ${image.id} is unacceptable: Image virtual size is 37GB and doesn't fit in a volume of size 26GB. (Request-ID: ${supportId})`,
    details: hostile };
  for (const path of ['/servers', `/servers/${server.id}`, `/servers/${server.id}/error`]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    const payload = await response.text();
    assert.match(payload, /IMAGE_SIZE_EXCEEDS_VOLUME/, path);
    for (const fragment of ['/var/lib/kolla', 'site-packages', 'nova.exception', 'cinderclient',
      'SUPER_SECRET', 'SECRET_TOKEN', 'rabbit://', 'internal-compute-host', 'BuildAbortException', 'InvalidBDM']) {
      assert.equal(payload.includes(fragment), false, `${path}: ${fragment}`);
    }
    assert.equal(payload.includes('"fault":'), false, path);
  }
  const normalized = (await (await request(`/servers/${server.id}/error`)).json()).error;
  assert.deepEqual(normalized.context, { required_disk_gb: 37, requested_volume_gb: 26 });
  assert.equal(normalized.request_id, supportId);
  assert.equal(normalized.image_name, image.name);
  const sizeEvent = (await (await request(`/servers/${server.id}/activity`)).json()).entries
    .find((entry) => entry.action === 'instance.error.detected' && entry.details.error_code === 'IMAGE_SIZE_EXCEEDS_VOLUME');
  assert.deepEqual({ required_disk_gb: sizeEvent.details.required_disk_gb,
    requested_volume_gb: sizeEvent.details.requested_volume_gb }, { required_disk_gb: 37, requested_volume_gb: 26 });
  assert.equal(JSON.stringify(sizeEvent).includes(hostile), false);

  const foreignImage = mockFetch('image', 'POST', '/v2/images', {
    name: 'FOREIGN-PRIVATE-IMAGE', visibility: 'private', disk_format: 'qcow2',
  }, 'p-devops');
  t.after(() => mockFetch('image', 'DELETE', `/v2/images/${foreignImage.id}`, null, 'p-devops'));
  foreignImage.status = 'active';
  server.fault.message = `InvalidBDM: Image ${foreignImage.id} is unacceptable: Image virtual size is 37GB and doesn't fit in a volume of size 26GB.`;
  const foreignResult = (await (await request(`/servers/${server.id}/error`)).json()).error;
  assert.equal(foreignResult.code, 'IMAGE_SIZE_EXCEEDS_VOLUME');
  assert.equal(foreignResult.image_name, undefined);
  assert.equal(JSON.stringify(foreignResult).includes('FOREIGN-PRIVATE-IMAGE'), false);

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
  const old = { min_disk: providerImage.min_disk, min_ram: providerImage.min_ram, virtual_size: providerImage.virtual_size };
  t.after(() => { providerImage.min_disk = old.min_disk; providerImage.min_ram = old.min_ram;
    providerImage.virtual_size = old.virtual_size; });
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
  providerImage.min_disk = 0;
  providerImage.virtual_size = 37 * 1024 ** 3;
  const smallBoot = await request('/servers', 'POST', { name: 'too-small-volume', flavorRef: 'f-small', imageRef: image.id,
    boot_volume_gb: 26 });
  assert.equal(smallBoot.status, 400);
  const smallBootBody = await smallBoot.json();
  assert.equal(smallBootBody.code, 'IMAGE_SIZE_EXCEEDS_VOLUME');
  assert.deepEqual(smallBootBody.context, { required_disk_gb: 37, requested_volume_gb: 26 });
  assert.equal(mockFetch('compute', 'GET', '/servers/detail', null, 'p-demo').servers.length, count);
  providerImage.virtual_size += 1;
  const roundedBoot = await request('/servers', 'POST', { name: 'rounded-volume', flavorRef: 'f-small', imageRef: image.id,
    boot_volume_gb: 37 });
  assert.equal(roundedBoot.status, 400);
  assert.deepEqual((await roundedBoot.json()).context, { required_disk_gb: 38, requested_volume_gb: 37 });
  const invalidBoot = await request('/servers', 'POST', { name: 'invalid-volume', flavorRef: 'f-small', imageRef: image.id,
    boot_volume_gb: 0 });
  assert.equal(invalidBoot.status, 400);
  assert.equal((await invalidBoot.json()).code, 'boot_volume_size_invalid');
  assert.equal(mockFetch('compute', 'GET', '/servers/detail', null, 'p-demo').servers.length, count);
  providerImage.min_ram = 8192;
  const ram = await request('/servers', 'POST', { name: 'should-not-build', flavorRef: 'f-small', imageRef: image.id, boot_volume_gb: 80 });
  assert.equal(ram.status, 400);
  assert.deepEqual((await ram.json()).context, { required_ram_mb: 8192, flavor_ram_mb: 2048 });
  assert.equal(mockFetch('compute', 'GET', '/servers/detail', null, 'p-demo').servers.length, count);
});
