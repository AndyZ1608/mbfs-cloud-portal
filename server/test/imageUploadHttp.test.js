import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { MAX_IMAGE_UPLOAD_BYTES } from '../../shared/imageUploadPolicy.mjs';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('ISO upload reaches Glance as binary and appears active in the current project', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'image-upload-http-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const login = await fetch(`${base}/auth/login`, { method: 'POST',
    headers: { 'X-CMP-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo' }) });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const upload = (filename, name, bytes = Buffer.from('ISO-BINARY-BYTES')) => fetch(`${base}/images/upload`, {
    method: 'POST', headers: { Cookie: cookie, 'X-CMP-Request': '1', 'Content-Type': 'application/octet-stream',
      'X-Image-Filename': encodeURIComponent(filename), 'X-Image-Name': encodeURIComponent(name) }, body: bytes,
  });
  const before = mockFetch('image', 'GET', '/v2/images', null, 'p-demo').images.length;
  for (const declaredSize of [MAX_IMAGE_UPLOAD_BYTES, 16 * 1024 ** 3, 20 * 1024 ** 3]) {
    const rejected = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/images/upload`, { method: 'POST', headers: {
        Cookie: cookie, 'X-CMP-Request': '1', 'Content-Type': 'application/octet-stream',
        'Content-Length': String(declaredSize), 'X-Image-Filename': 'huge.iso', 'X-Image-Name': 'Huge',
      } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.code, 'image_upload_too_large');
  }
  assert.equal(mockFetch('image', 'GET', '/v2/images', null, 'p-demo').images.length, before);
  for (const filename of ['bad.raw', 'bad.img', 'bad.qcow2.gz']) {
    const rejected = await upload(filename, 'Rejected');
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'image_unsupported_format');
  }
  assert.equal(mockFetch('image', 'GET', '/v2/images', null, 'p-demo').images.length, before);
  const response = await upload('recovery.ISO', 'Recovery media');
  assert.equal(response.status, 200);
  const { image, processing } = await response.json();
  assert.equal(processing, false);
  assert.equal(image.status, 'active');
  assert.equal(image.disk_format, 'iso');
  assert.equal(image.container_format, 'bare');
  assert.equal(image.owner, 'p-demo');
  assert.equal(image.size, Buffer.byteLength('ISO-BINARY-BYTES'));
  t.after(() => mockFetch('image', 'DELETE', `/v2/images/${image.id}`, null, 'p-demo'));
  const list = await fetch(`${base}/images`, { headers: { Cookie: cookie } });
  assert.ok((await list.json()).images.some((item) => item.id === image.id && item.status === 'active'));
  assert.equal((await fetch(`${base}/images`, { method: 'POST', headers: { Cookie: cookie,
    'X-CMP-Request': '1', 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'bypass', disk_format: 'raw' }) })).status, 404);
  const switched = await fetch(`${base}/auth/switch-project`, { method: 'POST',
    headers: { Cookie: cookie, 'X-CMP-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'p-devops' }) });
  assert.equal(switched.status, 200);
  if (switched.headers.get('set-cookie')) cookie = switched.headers.get('set-cookie').split(';')[0];
  assert.ok(!(await (await fetch(`${base}/images`, { headers: { Cookie: cookie } })).json()).images
    .some((item) => item.id === image.id));
});
