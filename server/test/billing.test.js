import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OS_MOCK = 'true';

const quietLogger = { info() {}, warn() {} };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('billing config: normalizes trailing slashes and validates enabled URLs', async () => {
  const { normalizeBillingConfig } = await import('../config.js');
  const valid = normalizeBillingConfig({ enabled: true, base_url: 'https://billing.internal/root///', timeout_seconds: 12 });
  assert.equal(valid.baseUrl, 'https://billing.internal/root');
  assert.equal(valid.timeoutMs, 12000);
  assert.deepEqual(valid.errors, []);

  assert.ok(normalizeBillingConfig({ enabled: true, base_url: '' }).errors.length);
  assert.ok(normalizeBillingConfig({ enabled: true, base_url: '100.64.64.150:8080' }).errors.length);
  assert.ok(normalizeBillingConfig({ enabled: true, base_url: 'file:///tmp/billing' }).errors.length);
});

test('billing client: constructs fixed URL, forwards scoped token, and sends no project_id', async () => {
  const { BillingClient } = await import('../billing/client.js');
  let call;
  const logs = [];
  const client = new BillingClient({
    baseUrl: 'http://billing.internal:8080/', timeoutMs: 1000,
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
    fetchImpl: async (url, options) => { call = { url, options }; return jsonResponse({ total_cost: '123.45' }); },
  });
  const data = await client.get('/api/v1/portal/billing', {
    token: 'project-a-token', requestId: 'request-1', projectId: 'project-a',
  });
  assert.equal(call.url, 'http://billing.internal:8080/api/v1/portal/billing');
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.headers['X-Auth-Token'], 'project-a-token');
  assert.equal(call.options.headers['X-Request-Id'], 'request-1');
  assert.equal(call.options.body, undefined);
  assert.equal(call.url.includes('project_id'), false);
  assert.equal(Object.keys(call.options.headers).some((key) => key.toLowerCase().includes('project')), false);
  assert.equal(logs.join('\n').includes('project-a-token'), false, 'Keystone token must never be logged');
  assert.deepEqual(data, { total_cost: '123.45' });
});

test('billing service: uses exact contract endpoints and the current session token', async () => {
  const { BillingService } = await import('../billing/service.js');
  const calls = [];
  const service = new BillingService({ get: async (path, context) => { calls.push({ path, context }); return {}; } });
  await service.summary({ token: 'token-a', project: { id: 'project-a' } }, 'r1');
  await service.instances({ token: 'token-b', project: { id: 'project-b' } }, 'r2');
  await service.instance({ token: 'token-b', project: { id: 'project-b' } }, 'vm/id', 'r3');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/v1/portal/billing',
    '/api/v1/portal/billing/instances',
    '/api/v1/portal/billing/instances/vm%2Fid',
  ]);
  assert.deepEqual(calls.map((call) => call.context.token), ['token-a', 'token-b', 'token-b']);
  assert.equal(calls.some((call) => call.path.includes('project')), false);
});

test('billing service: never forwards a bridge-SSO service-account token', async () => {
  const { BillingService } = await import('../billing/service.js');
  let called = false;
  const service = new BillingService({ get: async () => { called = true; return {}; } });
  assert.throws(
    () => service.summary({ token: 'service-token', token_source: 'service', auth_mode: 'sso', project: { id: 'project-a' } }, 'r1'),
    (error) => error.code === 'billing_user_token_required'
  );
  assert.equal(called, false);
});

test('billing client: translates 401, 403, 404, and 500', async () => {
  const { BillingClient } = await import('../billing/client.js');
  const expected = new Map([[401, 'billing_unauthorized'], [403, 'billing_forbidden'], [404, 'billing_not_found'], [500, 'billing_unavailable']]);
  for (const [status, code] of expected) {
    const client = new BillingClient({ baseUrl: 'http://billing', timeoutMs: 100, logger: quietLogger, fetchImpl: async () => jsonResponse({ error: 'sensitive upstream detail' }, status) });
    await assert.rejects(() => client.get('/api/v1/portal/billing', { token: 'token' }), (error) => error.code === code);
  }
});

test('billing client: translates network failure and timeout', async () => {
  const { BillingClient } = await import('../billing/client.js');
  const network = new BillingClient({ baseUrl: 'http://billing', timeoutMs: 100, logger: quietLogger, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => network.get('/api/v1/portal/billing', { token: 'token' }), (error) => error.code === 'billing_unavailable');

  const timeout = new BillingClient({
    baseUrl: 'http://billing', timeoutMs: 5, logger: quietLogger,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
  });
  await assert.rejects(() => timeout.get('/api/v1/portal/billing', { token: 'token' }), (error) => error.code === 'billing_timeout');
});

test('billing client: rejects malformed and primitive JSON responses', async () => {
  const { BillingClient } = await import('../billing/client.js');
  const malformed = new BillingClient({ baseUrl: 'http://billing', timeoutMs: 100, logger: quietLogger, fetchImpl: async () => new Response('{bad', { status: 200 }) });
  await assert.rejects(() => malformed.get('/api/v1/portal/billing', { token: 'token' }), (error) => error.code === 'billing_invalid_response');
  const primitive = new BillingClient({ baseUrl: 'http://billing', timeoutMs: 100, logger: quietLogger, fetchImpl: async () => jsonResponse('not-an-object') });
  await assert.rejects(() => primitive.get('/api/v1/portal/billing', { token: 'token' }), (error) => error.code === 'billing_invalid_response');
});
