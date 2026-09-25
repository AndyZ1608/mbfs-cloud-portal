import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('project-scoped image catalog follows Glance pages and keeps metadata', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const created = [];
  for (let index = 0; index < 201; index++) {
    const image = mockFetch('image', 'POST', '/v2/images', {
      name: `catalog-test-${index}`, disk_format: 'qcow2', visibility: 'private',
    }, 'p-demo');
    image.status = 'active';
    image.os_distro = 'oraclelinux';
    created.push(image.id);
  }
  const foreign = mockFetch('image', 'POST', '/v2/images', {
    name: 'foreign-catalog-test', disk_format: 'qcow2', visibility: 'private',
  }, 'p-devops');
  foreign.status = 'active';
  t.after(() => mockFetch('image', 'DELETE', `/v2/images/${foreign.id}`, null, 'p-devops'));
  t.after(() => { for (const id of created) mockFetch('image', 'DELETE', `/v2/images/${id}`, null, 'p-demo'); });
  const app = createApp({ sessionStore: null, sessionSecret: 'image-catalog-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'X-CMP-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/images`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const { images } = await response.json();
  assert.ok(created.every((id) => images.some((image) => image.id === id && image.os_distro === 'oraclelinux')));
  assert.ok(!images.some((image) => image.id === foreign.id));
  assert.ok(images.some((image) => image.os_distro === 'ubuntu' && image.os_version === '24.04'));
});
