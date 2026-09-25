import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('Nova resize, confirm, and revert accept empty 2xx bodies but reject errors', async (t) => {
  const previousMock = process.env.OS_MOCK;
  process.env.OS_MOCK = 'false';
  const { osFetch } = await import('../openstack.js?resize-response-regression');
  process.env.OS_MOCK = previousMock;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const session = {
    token: 'test-scoped-token',
    catalog: [{ type: 'compute', endpoints: [{ interface: 'public', url: 'https://nova.invalid/v2.1' }] }],
  };
  const cases = [
    { name: 'resize 202 Content-Length 0', body: { resize: { flavorRef: 'f-large' } },
      response: () => new Response('', { status: 202, headers: { 'Content-Type': 'application/json', 'Content-Length': '0' } }), ok: true },
    { name: 'resize 202 no Content-Type', body: { resize: { flavorRef: 'f-large' } },
      response: () => new Response(null, { status: 202 }), ok: true },
    { name: 'confirmResize 202 empty', body: { confirmResize: null },
      response: () => new Response(null, { status: 202, headers: { 'Content-Type': 'application/json' } }), ok: true },
    { name: 'revertResize 204 empty', body: { revertResize: null },
      response: () => new Response(null, { status: 204 }), ok: true },
    { name: 'resize 409 JSON', body: { resize: { flavorRef: 'f-large' } },
      response: () => new Response(JSON.stringify({ conflict: { message: 'Invalid VM state' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }), status: 409 },
    { name: 'resize 500 JSON', body: { resize: { flavorRef: 'f-large' } },
      response: () => new Response(JSON.stringify({ computeFault: { message: 'Nova failure' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }), status: 500 },
  ];
  for (const scenario of cases) {
    let request;
    globalThis.fetch = async (_url, options) => {
      request = options;
      return scenario.response();
    };
    const call = osFetch(session, 'compute', '/servers/vm-1/action', {
      method: 'POST', body: scenario.body, responseType: 'none',
    });
    if (scenario.ok) assert.equal(await call, null, scenario.name);
    else await assert.rejects(call, { status: scenario.status });
    assert.deepEqual(JSON.parse(request.body), scenario.body, scenario.name);
    assert.equal(request.method, 'POST');
  }
});

test('resize errors have useful fixed messages without raw provider text', async () => {
  const { resizeError } = await import('../routes/compute.js');
  const cases = [
    [400, 'invalid_resize_request'], [403, 'permission_denied'],
    [404, 'resource_not_found'], [409, 'invalid_instance_state'],
    [500, 'resize_provider_failure'], [503, 'provider_unavailable'],
  ];
  for (const [status, code] of cases) {
    const mapped = resizeError(Object.assign(new Error('private Nova detail'), { status }));
    assert.equal(mapped.code, code);
    assert.equal(mapped.expose, true);
    assert.equal(mapped.message.includes('private Nova detail'), false);
  }
  assert.equal(resizeError(Object.assign(new Error('NoValidHost'), { status: 500 })).code, 'insufficient_capacity');
});

test('CMP resize workflow returns accepted contract, enforces scope, and audits outcomes', async (t) => {
  const { createApp } = await import('../app.js');
  const { listAudit } = await import('../audit.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'resize-feature-test-session-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (path, cookie, body) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CMP-Request': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const get = (path, cookie) => fetch(base + path, { headers: { Cookie: cookie } }).then((response) => response.json());
  const action = (id, cookie, body) => post(`/api/servers/${id}/action`, cookie, body);

  assert.equal((await action('vm-1', null, { action: 'resize', flavorRef: 'f-large' })).status, 401);
  const login = await post('/api/auth/login', null, { username: 'resize-feature-test', password: 'demo' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const servers = (await get('/api/servers', cookie)).servers;
  const [first, second] = servers.filter((server) => server.status === 'ACTIVE');
  const firstOriginalFlavor = first.flavor.id;
  const secondOriginalFlavor = second.flavor.id;
  const flavors = (await get('/api/flavors', cookie)).flavors;
  const targetFirst = flavors.find((flavor) => flavor.id !== first.flavor.id);
  const targetSecond = flavors.find((flavor) => flavor.id !== second.flavor.id);
  assert.equal((await action(first.id, cookie, { action: 'resize', flavorRef: first.flavor.id })).status, 400);

  for (const [server, target] of [[first, targetFirst], [second, targetSecond]]) {
    const response = await action(server.id, cookie, { action: 'resize', flavorRef: target.id, project_id: 'other-project' });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { success: true, accepted: true });
    assert.equal((await get(`/api/servers/${server.id}`, cookie)).server.status, 'RESIZE');
  }
  const duplicate = await action(first.id, cookie, { action: 'resize', flavorRef: targetFirst.id });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'invalid_instance_state');
  await new Promise((resolve) => setTimeout(resolve, 3100));
  assert.equal((await get(`/api/servers/${first.id}`, cookie)).server.status, 'VERIFY_RESIZE');
  assert.equal((await get(`/api/servers/${second.id}`, cookie)).server.status, 'VERIFY_RESIZE');

  const confirm = await action(first.id, cookie, { action: 'confirm-resize' });
  const revert = await action(second.id, cookie, { action: 'revert-resize' });
  assert.equal(confirm.status, 202);
  assert.equal(revert.status, 202);
  assert.deepEqual(await confirm.json(), { success: true, accepted: true });
  assert.deepEqual(await revert.json(), { success: true, accepted: true });
  assert.equal((await get(`/api/servers/${first.id}`, cookie)).server.flavor.id, targetFirst.id);
  assert.equal((await get(`/api/servers/${second.id}`, cookie)).server.flavor.id, secondOriginalFlavor);

  const audit = listAudit({ projectId: 'p-demo', user: 'resize-feature-test', limit: 30 })
    .filter((entry) => entry.action?.startsWith('instance.') && entry.action.includes('resize')).slice(0, 5);
  assert.deepEqual(audit.map((entry) => [entry.action, entry.result]), [
    ['instance.resize.revert', 'accepted'], ['instance.resize.confirm', 'accepted'],
    ['instance.resize.request', 'failure'], ['instance.resize.request', 'accepted'], ['instance.resize.request', 'accepted'],
  ]);
  assert.equal(audit[3].requested_flavor, targetSecond.id);
  assert.equal(audit[4].old_flavor, firstOriginalFlavor);
  assert.equal(audit[4].instance_id, first.id);

  assert.equal((await post('/api/auth/switch-project', cookie, { projectId: 'p-devops' })).status, 200);
  assert.equal((await action(first.id, cookie, { action: 'resize', flavorRef: targetSecond.id })).status, 404);
});
