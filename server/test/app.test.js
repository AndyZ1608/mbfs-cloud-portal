import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));

test('app boundary: health, request ID, CSRF rejection, and valid login', async (t) => {
  const { createApp } = await import('../app.js');
  const server = createApp({ sessionStore: null, sessionSecret: 'test-secret-with-more-than-32-characters' }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.ok(health.headers.get('x-request-id'));

  const rejected = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo' }),
  });
  assert.equal(rejected.status, 403);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.code, 'csrf_rejected');
  assert.equal(rejectedBody.requestId, rejected.headers.get('x-request-id'));

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cmp-request': '1' },
    body: JSON.stringify({ username: 'demo', password: 'demo' }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie') || '', /mbfs_cloud_sid=/);
});

