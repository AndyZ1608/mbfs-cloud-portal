import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const username = 'account-password-self-test';
const oldPassword = 'demo';
const newPassword = 'new-local-password-701';

test('Keystone self-service client accepts an empty 204, never parses it, and sanitizes errors', async (t) => {
  const previousMock = process.env.OS_MOCK;
  process.env.OS_MOCK = 'false';
  const { changeOwnKeystonePassword } = await import('../openstack.js?account-password-real-client');
  process.env.OS_MOCK = previousMock;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const session = { user: { id: 'current-user-id' } };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 204 });
  };
  await changeOwnKeystonePassword(session, oldPassword, newPassword);
  assert.match(calls[0].url, /\/v3\/users\/current-user-id\/password$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-Auth-Token'], undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    user: { original_password: oldPassword, password: newPassword },
  });
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await changeOwnKeystonePassword(session, oldPassword, newPassword);
  for (const [status, code] of [
    [400, 'account_password_rejected'], [401, 'account_current_password_incorrect'],
    [403, 'account_password_unsupported'], [404, 'account_password_unsupported'],
    [409, 'account_password_rejected'], [500, 'account_keystone_unavailable'],
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: `secret ${newPassword}` } }), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(changeOwnKeystonePassword(session, oldPassword, newPassword), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes(newPassword), false);
      return true;
    });
  }
  globalThis.fetch = async () => { throw new Error(`secret ${newPassword}`); };
  await assert.rejects(changeOwnKeystonePassword(session, oldPassword, newPassword), {
    code: 'account_keystone_unavailable',
  });
});

test('external and service-backed sessions cannot invoke the local Keystone password flow', async (t) => {
  const express = (await import('express')).default;
  const { default: accountRoutes } = await import('../routes/account.js');
  const { errorHandler } = await import('../middleware.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { os: { auth_mode: req.get('x-test-auth-mode'), token_source: req.get('x-test-token-source'),
      user: { id: 'u-external', name: 'external' }, project: { id: 'p-demo', name: 'demo-project' } } };
    next();
  });
  app.use(accountRoutes);
  app.use(errorHandler);
  const listener = app.listen(0);
  await new Promise((resolve) => listener.once('listening', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const url = `http://127.0.0.1:${listener.address().port}/account/change-password`;
  for (const [mode, source] of [['sso', 'service'], ['websso', 'user']]) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Test-Auth-Mode': mode, 'X-Test-Token-Source': source },
      body: JSON.stringify({ current_password: oldPassword, new_password: newPassword }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'account_password_unsupported');
  }
});

test('current Keystone user changes password after project switch; session ends and audit stores no secret', async (t) => {
  const { createApp } = await import('../app.js');
  const { listAudit } = await import('../audit.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'account-password-test-session-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie = '';
  const request = (path, method = 'GET', body, includeCsrf = true) => fetch(base + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', ...(includeCsrf ? { 'X-CMP-Request': '1' } : {}) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = { current_password: oldPassword, new_password: newPassword, user_id: 'another-user', confirm_password: 'ignored' };
  assert.equal((await request('/account/change-password', 'POST', payload)).status, 401);
  const login = await request('/auth/login', 'POST', { username, password: oldPassword });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const initial = await (await request('/auth/session')).json();
  const userId = initial.user.id;
  assert.equal((await request('/account/change-password', 'POST', payload, false)).status, 403);
  const observedLogs = [];
  const originalLog = console.log;
  console.log = (...parts) => { observedLogs.push(parts.join(' ')); };
  try {
    const malformed = await request(`/account/change-password?new_password=${encodeURIComponent(newPassword)}`,
      'POST', { current_password: 'wrong-current-password', new_password: 'unused-secret' });
    assert.equal(malformed.status, 401);
    await malformed.json();
    await new Promise((resolve) => setImmediate(resolve));
  } finally { console.log = originalLog; }
  assert.equal(observedLogs.join('\n').includes(newPassword), false);
  const switched = await request('/auth/switch-project', 'POST', { projectId: 'p-devops' });
  assert.equal(switched.status, 200);
  await switched.json();
  const afterSwitch = await (await request('/auth/session')).json();
  assert.equal(afterSwitch.user.id, userId);
  assert.equal(afterSwitch.project.id, 'p-devops');

  const wrong = await request('/account/change-password', 'POST', { ...payload, current_password: 'wrong-current-password' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).code, 'account_current_password_incorrect');
  assert.equal((await request('/auth/session')).status, 200);
  const same = await request('/account/change-password', 'POST', { current_password: oldPassword, new_password: oldPassword });
  assert.equal(same.status, 400);
  assert.equal((await same.json()).code, 'account_password_same');

  const success = await request('/account/change-password', 'POST', payload);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { success: true });
  assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.match(success.headers.get('set-cookie') || '', /mbfs_cloud_sid=;/);
  assert.equal((await request('/auth/session')).status, 401);
  const entries = listAudit({ projectId: 'p-devops', user: username, limit: 40 })
    .filter((entry) => entry.action === 'account.password.change' && entry.user_id === userId);
  assert.ok(entries.some((entry) => entry.result === 'success'));
  assert.ok(entries.some((entry) => entry.result === 'failure' && entry.details.reason === 'incorrect_current_password'));
  assert.ok(entries.every((entry) => entry.resource_id === userId && entry.project_id === 'p-devops'));
  const auditFile = readFileSync(fileURLToPath(new URL('../.test-data/audit.jsonl', import.meta.url)), 'utf8');
  const persisted = auditFile.split('\n').filter((line) => line.includes('account.password.change') && line.includes(username))
    .map((line) => JSON.parse(line));
  for (const entry of persisted) {
    assert.equal('body' in entry, false);
    assert.equal(JSON.stringify(entry.details).includes(oldPassword), false);
  }
  for (const secret of [newPassword, 'wrong-current-password']) {
    assert.equal(JSON.stringify(entries).includes(secret), false);
    assert.equal(JSON.stringify(persisted).includes(secret), false);
  }
  const oldLogin = await request('/auth/login', 'POST', { username, password: oldPassword });
  assert.equal(oldLogin.status, 401);
  const freshLogin = await request('/auth/login', 'POST', { username, password: newPassword });
  assert.equal(freshLogin.status, 200);
  cookie = freshLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/auth/session')).status, 200);
  let rateLimited = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await request('/account/change-password', 'POST', {
      current_password: 'wrong-current-password', new_password: 'unused-secret',
    });
    if (response.status === 429) { rateLimited = true; break; }
    assert.equal(response.status, 401);
  }
  assert.equal(rateLimited, true);
});
