import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OS_MOCK = 'false';
process.env.OS_AUTH_URL = 'https://keystone.example/v3';
process.env.SSO_KEYSTONE_USERNAME = 'sso-identity-service';
process.env.SSO_KEYSTONE_PASSWORD = 'service-secret-not-for-browser';
process.env.SSO_KEYSTONE_DOMAIN = 'Default';
process.env.SSO_PROVISIONING_ENABLED = 'true';
const { proveKeystoneOwnership, createKeystoneUser, deleteNewKeystoneUser,
  getKeystoneUserById } = await import('../keystoneSsoAccounts.js');

const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
const json = (value, options = {}) => new Response(JSON.stringify(value), {
  status: options.status || 200,
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
});

test('one-time ownership proof uses Keystone password auth and maps bad credentials to a generic error', async () => {
  const password = 'one-time-password';
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).auth.identity.password.user.password, password);
    return json({ error: { message: `echo ${password}` } }, { status: 401 });
  };
  await assert.rejects(proveKeystoneOwnership('existing', password, 'Default'), (error) => {
    assert.equal(error.code, 'sso_ownership_failed');
    assert.equal(error.message.includes(password), false);
    return true;
  });
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).auth.identity.password.user.name, 'existing');
    return json({ token: { user: { id: 'u-verified', name: 'existing' } } },
      { headers: { 'X-Subject-Token': 'discard-this-proof-token' } });
  };
  assert.equal(await proveKeystoneOwnership('existing', password, 'Default'), 'u-verified');
});

test('dedicated system-scoped service provisions a passwordless user without project or role assignment', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if (String(url).endsWith('/auth/tokens')) {
      const auth = JSON.parse(options.body).auth;
      assert.deepEqual(auth.scope, { system: { all: true } });
      assert.equal(auth.identity.password.user.name, 'sso-identity-service');
      return json({ token: {} }, { headers: { 'X-Subject-Token': 'service-token' } });
    }
    assert.equal(options.headers['X-Auth-Token'], 'service-token');
    if (String(url).includes('/domains?')) return json({ domains: [{ id: 'domain-id', name: 'Default' }] });
    if (String(url).includes('/users?')) return json({ users: [] });
    if (options.method === 'POST' && String(url).endsWith('/users')) {
      assert.deepEqual(JSON.parse(options.body), { user: {
        name: 'new-user', domain_id: 'domain-id', enabled: true, email: 'verified@example.com',
      } });
      return json({ user: { id: 'u-new', name: 'new-user', enabled: true } }, { status: 201 });
    }
    if (options.method === 'GET' && String(url).endsWith('/users/u-new')) {
      return json({ user: { id: 'u-new', name: 'new-user', enabled: true } });
    }
    if (options.method === 'DELETE' && String(url).endsWith('/users/u-new')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected test request ${options.method} ${url}`);
  };
  const user = await createKeystoneUser('new-user', 'verified@example.com');
  assert.equal(user.id, 'u-new');
  assert.equal((await getKeystoneUserById('u-new')).enabled, true);
  await deleteNewKeystoneUser('u-new');
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/users/u-new')));
});

test('username collision is not treated as proof of account ownership', async () => {
  let created = false;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/auth/tokens')) return json({ token: {} }, { headers: { 'X-Subject-Token': 'service-token' } });
    if (String(url).includes('/domains?')) return json({ domains: [{ id: 'domain-id', name: 'Default' }] });
    if (String(url).includes('/users?')) return json({ users: [{ id: 'existing-id', name: 'taken', domain_id: 'domain-id' }] });
    if (options.method === 'POST') created = true;
    throw new Error('Unexpected request');
  };
  await assert.rejects(createKeystoneUser('taken', null), { code: 'sso_username_collision' });
  assert.equal(created, false);
});
