import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const testData = mkdtempSync(path.join(tmpdir(), 'cmp-sso-test-'));
process.env.DATA_DIR = testData;
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';
process.env.OS_MOCK = 'true';
process.env.SSO_ENABLED = 'true';
process.env.SSO_ALLOW_LOCAL_LOGIN = 'false'; // legacy setting must not disable Phase 1 fallback
process.env.SSO_PROVISIONING_ENABLED = 'true';
process.env.OIDC_CLIENT_ID = 'cmp-test';
process.env.OIDC_CLIENT_SECRET = 'test-secret';
process.env.OIDC_REDIRECT_URI = 'http://127.0.0.1:8888/api/auth/sso/callback';
process.env.RATE_LOGIN_MAX = '100';
process.env.RATE_API_MAX = '1000';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const codes = new Map();
let issuer;
const idp = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  if (url.pathname === '/realm/.well-known/openid-configuration') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'] }));
    return;
  }
  if (url.pathname === '/realm/jwks') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }));
    return;
  }
  if (url.pathname === '/realm/token') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = new URLSearchParams(body);
    const info = codes.get(input.get('code'));
    if (!info || input.get('client_id') !== 'cmp-test' || input.get('client_secret') !== 'test-secret') {
      res.writeHead(400); res.end('{}'); return;
    }
    codes.delete(input.get('code'));
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, sub: info.subject || 'subject-1', aud: 'cmp-test',
      iat: now, exp: now + 300, nonce: info.nonce, preferred_username: info.username || 'hieptd',
      email: info.email || 'person@example.com', email_verified: true, name: 'Test Person', ...info.claims };
    const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const head = encoded({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
    const payload = encoded(claims);
    const signature = info.badSignature ? 'invalid-signature'
      : sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), privateKey).toString('base64url');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: 'secret-access-token', token_type: 'Bearer',
      id_token: `${head}.${payload}.${signature}`, expires_in: 300 }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => idp.listen(0, '127.0.0.1', resolve));
issuer = `http://127.0.0.1:${idp.address().port}/realm`;
process.env.OIDC_ISSUER_URL = issuer;

const { createApp } = await import('../app.js');
const { createBinding, findBySsoIdentity } = await import('../ssoBindings.js');
const { classificationDb, closeClassificationDb } = await import('../classificationDb.js');
const app = createApp({ sessionSecret: 'sso-test-secret-that-is-long-enough-to-use' });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(async () => {
  closeClassificationDb();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => idp.close(resolve))]);
  rmSync(testData, { recursive: true, force: true });
});

async function start(options = {}) {
  const response = await fetch(`${base}/api/auth/sso/login`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const auth = new URL(response.headers.get('location'));
  assert.equal(auth.searchParams.get('client_id'), 'cmp-test');
  assert.equal(auth.searchParams.get('redirect_uri'), process.env.OIDC_REDIRECT_URI);
  assert.equal(auth.searchParams.get('scope'), 'openid profile email');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(auth.searchParams.get('state'));
  assert.ok(auth.searchParams.get('nonce'));
  assert.ok(auth.searchParams.get('code_challenge'));
  const code = randomUUID();
  codes.set(code, { nonce: auth.searchParams.get('nonce'), ...options });
  return { cookie, auth, code };
}

async function callback(login, state = login.auth.searchParams.get('state')) {
  const response = await fetch(`${base}/api/auth/sso/callback?code=${login.code}&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: login.cookie }, redirect: 'manual' });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] || login.cookie };
}

async function request(route, cookie, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method, headers: {
    Cookie: cookie, ...(method === 'GET' ? {} : { 'X-CMP-Request': '1' }),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}

test('OIDC start creates fresh state, nonce and PKCE S256 with no client secret in URL', async () => {
  const a = await start(); const b = await start();
  for (const field of ['state', 'nonce', 'code_challenge']) {
    assert.notEqual(a.auth.searchParams.get(field), b.auth.searchParams.get(field));
  }
  assert.equal(a.auth.href.includes('test-secret'), false);
});

test('callback verifies OIDC and rotates session; SSO session cannot use OpenStack APIs', async () => {
  const login = await start({ subject: 'fresh-identity' });
  const result = await callback(login);
  assert.equal(result.response.headers.get('location'), '/sso/onboarding');
  assert.equal(result.response.headers.get('referrer-policy'), 'no-referrer');
  assert.notEqual(result.cookie, login.cookie);
  const status = await request('/auth/session', result.cookie);
  assert.equal(status.data.auth_state, 'SSO_VERIFIED_UNBOUND');
  assert.equal(JSON.stringify(status.data).includes('fresh-identity'), false);
  assert.equal(JSON.stringify(status.data).includes('secret-access-token'), false);
  assert.equal((await request('/servers', result.cookie)).status, 401);
});

test('bad state, nonce, issuer, audience and expiry never establish an SSO session', async () => {
  const scenarios = [
    [{}, 'wrong-state'],
    [{ claims: { nonce: 'wrong-nonce' } }, null],
    [{ claims: { iss: 'http://other.example/realm' } }, null],
    [{ claims: { aud: 'another-client' } }, null],
    [{ claims: { exp: Math.floor(Date.now() / 1000) - 60 } }, null],
    [{ badSignature: true }, null],
  ];
  for (const [options, badState] of scenarios) {
    const login = await start(options);
    const result = await callback(login, badState || login.auth.searchParams.get('state'));
    assert.equal(result.response.headers.get('location'), '/login?sso_error=failed');
    assert.equal((await request('/auth/session', result.cookie)).status, 401);
  }
});

test('existing binding survives email change; same email with another subject stays unbound', async () => {
  const first = { provider: 'keycloak', issuer, subject: 'bound-subject',
    username: 'old-name', email: 'old@example.com' };
  createBinding(first, 'u-hieptd');
  const bound = await callback(await start({ subject: 'bound-subject', email: 'new@example.com' }));
  assert.equal((await request('/auth/session', bound.cookie)).data.auth_state, 'SSO_VERIFIED_BOUND');
  assert.equal(findBySsoIdentity(first).sso_email, 'new@example.com');
  const other = await callback(await start({ subject: 'other-subject', email: 'new@example.com' }));
  assert.equal((await request('/auth/session', other.cookie)).data.auth_state, 'SSO_VERIFIED_UNBOUND');
});

test('link uses Keystone password proof, enforces collision and never stores proof token', async () => {
  const login = await callback(await start({ subject: 'link-subject' }));
  const wrong = await request('/auth/sso/link-existing', login.cookie, 'POST', { username: 'hieptd', password: '' });
  assert.equal(wrong.status, 400);
  const collision = await request('/auth/sso/link-existing', login.cookie, 'POST', { username: 'hieptd', password: 'valid' });
  assert.equal(collision.status, 409); // bound in the previous test
  const linked = await request('/auth/sso/link-existing', login.cookie, 'POST', { username: 'admin', password: 'valid' });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.bindingStatus, 'bound');
  assert.equal(JSON.stringify(linked.data).includes('mock-unscoped'), false);
  assert.equal((await request('/servers', login.cookie)).status, 401);
});

test('passwordless provisioning is idempotent and creates no project-scoped session', async () => {
  const login = await callback(await start({ subject: 'create-subject', username: 'fresh-cloud-user' }));
  const [first, second] = await Promise.all([
    request('/auth/sso/create-cloud-account', login.cookie, 'POST'),
    request('/auth/sso/create-cloud-account', login.cookie, 'POST'),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(findBySsoIdentity({ provider: 'keycloak', issuer, subject: 'create-subject' })?.keystone_user_id?.startsWith('u-'), true);
  assert.equal((await request('/servers', login.cookie)).status, 401);
});

test('bound missing or disabled Keystone users never become ready', async () => {
  createBinding({ provider: 'keycloak', issuer, subject: 'missing-subject' }, 'u-gone');
  const missing = await callback(await start({ subject: 'missing-subject' }));
  assert.equal((await request('/auth/session', missing.cookie)).data.auth_state, 'SSO_BOUND_USER_MISSING');
  const { mockFetch } = await import('../mock.js');
  const disabledUser = mockFetch('identity', 'POST', '/v3/users', { user: { name: 'disabled-test', domain_id: 'default' } }).user;
  disabledUser.enabled = false;
  createBinding({ provider: 'keycloak', issuer, subject: 'disabled-subject' }, disabledUser.id);
  const disabled = await callback(await start({ subject: 'disabled-subject' }));
  assert.equal((await request('/auth/session', disabled.cookie)).data.auth_state, 'SSO_BOUND_USER_DISABLED');
  assert.equal((await request('/servers', disabled.cookie)).status, 401);
});

test('username collision does not auto-link and local Keystone login remains available', async () => {
  const login = await callback(await start({ subject: 'collision-subject', username: 'admin' }));
  const result = await request('/auth/sso/create-cloud-account', login.cookie, 'POST');
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'sso_username_collision');
  assert.equal(findBySsoIdentity({ provider: 'keycloak', issuer, subject: 'collision-subject' }), null);
  const local = await request('/auth/login', '', 'POST', { username: 'hieptd', password: 'valid' });
  assert.equal(local.status, 200);
  assert.ok(local.data.project.id);
});

test('failed binding insert cleans up only the newly provisioned Keystone user', async () => {
  const login = await callback(await start({ subject: 'rollback-subject', username: 'rollback-test' }));
  const db = classificationDb();
  db.exec(`CREATE TRIGGER fail_sso_binding BEFORE INSERT ON sso_identity_bindings
    BEGIN SELECT RAISE(ABORT, 'test binding failure'); END;`);
  try {
    const failed = await request('/auth/sso/create-cloud-account', login.cookie, 'POST');
    assert.equal(failed.status, 500);
  } finally { db.exec('DROP TRIGGER fail_sso_binding'); }
  const { mockFetch } = await import('../mock.js');
  assert.deepEqual(mockFetch('identity', 'GET', '/v3/users?name=rollback-test&domain_id=default').users, []);
  assert.equal(findBySsoIdentity({ provider: 'keycloak', issuer, subject: 'rollback-subject' }), null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sso_onboarding_claims WHERE issuer = ? AND subject = ?`)
    .get(issuer, 'rollback-subject').n, 0);
});

test('onboarding writes require CSRF header; logout destroys the SSO session', async () => {
  const login = await start({ subject: 'csrf-subject' });
  const authenticated = await callback(login);
  const rejected = await fetch(`${base}/api/auth/sso/link-existing`, { method: 'POST',
    headers: { Cookie: authenticated.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'unused' }) });
  assert.equal(rejected.status, 403);
  assert.equal(findBySsoIdentity({ provider: 'keycloak', issuer, subject: 'csrf-subject' }), null);
  const out = await fetch(`${base}/api/auth/sso/logout`, { method: 'POST',
    headers: { Cookie: authenticated.cookie, 'X-CMP-Request': '1' } });
  assert.equal(out.status, 200);
  assert.equal((await request('/auth/session', authenticated.cookie)).status, 401);
  const replay = await callback(login);
  assert.equal(replay.response.headers.get('location'), '/login?sso_error=failed');
});

test('browser cannot submit issuer, subject, Keystone UUID, project or role authority', async () => {
  const login = await callback(await start({ subject: 'spoof-subject', username: 'spoof-test' }));
  const link = await request('/auth/sso/link-existing', login.cookie, 'POST', {
    username: 'admin', password: 'valid', subject: 'bound-subject', keystone_user_id: 'u-hieptd',
  });
  assert.equal(link.status, 400);
  assert.equal(link.data.code, 'sso_invalid_input');
  const create = await request('/auth/sso/create-cloud-account', login.cookie, 'POST', {
    role: 'admin', project: 'p-demo', keystone_user_id: 'u-admin',
  });
  assert.equal(create.status, 400);
  assert.equal(create.data.code, 'sso_invalid_input');
  assert.equal(findBySsoIdentity({ provider: 'keycloak', issuer, subject: 'spoof-subject' }), null);
});
