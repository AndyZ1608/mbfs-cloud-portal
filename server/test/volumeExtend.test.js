import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const catalog = [{ type: 'volumev3', endpoints: [{ interface: 'public', url: 'https://cinder.example/v3/project-a' }] }];
const session = { token: 'test-token', catalog, project: { id: 'project-a' } };

test('Cinder discovery targets v3 root and rejects older or unknown ranges', async () => {
  const { cinderVersionDiscoveryUrl, ensureOnlineExtendVersion } = await import('../volumeExtend.js');
  assert.equal(cinderVersionDiscoveryUrl(catalog), 'https://cinder.example/v3/');
  const request = (max) => async (url, options) => {
    assert.equal(url, 'https://cinder.example/v3/');
    assert.equal(options.headers['X-Auth-Token'], 'test-token');
    return new Response(JSON.stringify({ version: { min_version: '3.0', version: max } }), { status: 200 });
  };
  assert.equal(await ensureOnlineExtendVersion(session, { request: request('3.42') }), '3.42');
  assert.equal(await ensureOnlineExtendVersion(session, { request: async () => new Response(JSON.stringify({
    version: { min_version: '3.43', version: '3.71' },
  }), { status: 200 }) }), '3.43');
  await assert.rejects(ensureOnlineExtendVersion(session, { request: request('3.41') }),
    { code: 'volume_online_extend_version_unsupported' });
  await assert.rejects(ensureOnlineExtendVersion(session, { request: async () => new Response('{}', { status: 200 }) }),
    { code: 'volume_api_version_unavailable' });
});

test('attached extend negotiates 3.42, available extend retains default, and invalid requests never reach Cinder', async () => {
  const { requestVolumeExtend } = await import('../volumeExtend.js');
  const calls = [];
  const request = async (...args) => { calls.push(args); return null; };
  let versionChecks = 0;
  const verifyVersion = async () => { versionChecks += 1; return '3.42'; };
  const attached = { id: 'attached-id', size: 50, status: 'in-use' };
  const available = { id: 'available-id', size: 50, status: 'available' };
  assert.deepEqual(await requestVolumeExtend(session, attached, 60, { request, verifyVersion, mock: false }),
    { success: true, accepted: true });
  assert.equal(versionChecks, 1);
  assert.equal(calls[0][3].headers['OpenStack-API-Version'], 'volume 3.42');
  assert.equal(calls[0][3].responseType, 'none');
  assert.deepEqual(calls[0][3].body, { 'os-extend': { new_size: 60 } });
  await requestVolumeExtend(session, available, 60, { request, verifyVersion, mock: false });
  assert.equal(versionChecks, 1);
  assert.equal(calls[1][3].headers, undefined);
  for (const size of [50, 40, 50.5, '60', 0, null]) {
    await assert.rejects(requestVolumeExtend(session, attached, size, { request, verifyVersion, mock: false }),
      { code: 'volume_extend_size_invalid' });
  }
  for (const status of ['extending', 'attaching', 'detaching', 'deleting', 'error']) {
    await assert.rejects(requestVolumeExtend(session, { ...attached, status }, 60, { request, verifyVersion, mock: false }),
      { code: 'volume_extend_state_invalid' });
  }
  assert.equal(calls.length, 2);
  assert.equal(versionChecks, 1);
});

test('online capability and policy errors are safe and do not trigger fallback mutations', async () => {
  const { requestVolumeExtend } = await import('../volumeExtend.js');
  const { OSError } = await import('../openstack.js');
  const volume = { id: 'attached-id', size: 50, status: 'in-use' };
  const calls = [];
  const request = async (...args) => { calls.push(args); throw new OSError(400, 'Driver does not support extend_attached_volume'); };
  await assert.rejects(requestVolumeExtend(session, volume, 60, { request, verifyVersion: async () => {}, mock: false }),
    { code: 'volume_online_extend_unsupported' });
  assert.equal(calls.length, 1);
  const forbidden = async () => { throw new OSError(403, 'Secret provider policy details'); };
  await assert.rejects(requestVolumeExtend(session, volume, 60, { request: forbidden, verifyVersion: async () => {}, mock: false }),
    { code: 'volume_online_extend_forbidden', message: 'Online extension is not permitted by cloud policy.' });
});

test('the real request client accepts an empty Cinder 202 without JSON parsing', async () => {
  process.env.OS_MOCK = 'false';
  const { osFetch } = await import('../openstack.js?volume-extend-empty');
  process.env.OS_MOCK = 'true';
  const previousFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return new Response(null, { status: 202, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await osFetch(session, 'volume', '/volumes/attached-id/action', {
      method: 'POST', body: { 'os-extend': { new_size: 60 } }, responseType: 'none',
      headers: { 'OpenStack-API-Version': 'volume 3.42' },
    });
    assert.equal(response, null);
    assert.equal(seen.url, 'https://cinder.example/v3/project-a/volumes/attached-id/action');
    assert.equal(seen.options.headers['OpenStack-API-Version'], 'volume 3.42');
  } finally { globalThis.fetch = previousFetch; }
});

test('HTTP endpoint enforces current-project ownership and returns 202 with semantic audit', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'volume-extend-http-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie;
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { 'X-CMP-Request': '1', 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = await request('/auth/login', 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const volumes = (await (await request('/volumes')).json()).volumes;
  const attached = volumes.find((volume) => volume.status === 'in-use');
  const available = volumes.find((volume) => volume.status === 'available');
  assert.ok(attached && available);
  const foreign = mockFetch('volume', 'POST', '/volumes', { volume: { name: 'foreign-extend', size: 50 } }, 'p-devops').volume;
  assert.equal((await request(`/volumes/${foreign.id}/extend`, 'POST', { new_size: 60 })).status, 404);
  for (const size of [attached.size, attached.size - 1, attached.size + 0.5, '120']) {
    assert.equal((await request(`/volumes/${attached.id}/extend`, 'POST', { new_size: size })).status, 400);
  }
  const accepted = await request(`/volumes/${attached.id}/extend`, 'POST', { new_size: attached.size + 10 });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { success: true, accepted: true });
  const now = (await (await request('/volumes')).json()).volumes.find((volume) => volume.id === attached.id);
  assert.equal(now.status, 'extending');
  assert.equal((await request(`/volumes/${attached.id}/extend`, 'POST', { new_size: attached.size + 20 })).status, 409);
  const availableAccepted = await request(`/volumes/${available.id}/extend`, 'POST', { new_size: available.size + 10 });
  assert.equal(availableAccepted.status, 202);
  const audit = (await (await request('/audit?limit=100')).json()).entries;
  const event = audit.find((entry) => entry.action === 'volume.extend.request' && entry.resource_id === attached.id);
  assert.ok(event);
  assert.equal(event.result, 'accepted');
  assert.deepEqual(event.details, { volume_id: attached.id, old_size_gb: attached.size,
    new_size_gb: attached.size + 10, attached: true });
  assert.equal(event.project_id, 'p-demo');
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = (await (await request('/volumes')).json()).volumes;
    if (current.find((volume) => volume.id === attached.id)?.size === attached.size + 10
      && current.find((volume) => volume.id === available.id)?.size === available.size + 10) {
      assert.equal(current.find((volume) => volume.id === attached.id).status, 'in-use');
      assert.equal(current.find((volume) => volume.id === available.id).status, 'available');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Cinder mock did not report final provider sizes');
});
