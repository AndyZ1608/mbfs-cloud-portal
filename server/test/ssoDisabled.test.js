import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OS_MOCK = 'true';
process.env.SSO_ENABLED = 'false';
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('SSO disabled needs no OIDC or SSO service configuration and local login works', async () => {
  const { createApp } = await import('../app.js');
  const server = createApp({ sessionSecret: 'disabled-sso-test-secret-with-enough-length' }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await (await fetch(`${base}/api/auth/config`)).json();
    assert.equal(config.sso, false);
    assert.equal(config.allowLocal, true);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CMP-Request': '1' },
      body: JSON.stringify({ username: 'hieptd', password: 'valid' }) });
    assert.equal(login.status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('SSO refuses process-wide TLS verification bypass flags', async () => {
  const { validateConfig } = await import('../config.js');
  const previous = { sso: process.env.SSO_ENABLED, os: process.env.OS_INSECURE, oidc: process.env.SSO_INSECURE };
  try {
    process.env.SSO_ENABLED = 'true';
    process.env.OS_INSECURE = 'true';
    assert.throws(() => validateConfig(), /OS_INSECURE cannot be used with SSO/);
    delete process.env.OS_INSECURE;
    process.env.SSO_INSECURE = 'true';
    assert.throws(() => validateConfig(), /SSO_INSECURE is no longer supported/);
  } finally {
    for (const [name, value] of [['SSO_ENABLED', previous.sso], ['OS_INSECURE', previous.os], ['SSO_INSECURE', previous.oidc]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
