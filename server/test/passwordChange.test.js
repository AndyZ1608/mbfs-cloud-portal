import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const { changeInstancePassword } = await import('../passwordChange.js');

const secret = 'do-not-log-this-password-701';
const session = { project: { id: 'project-a' }, roles: ['member'] };
const server = { id: 'vm-1', name: 'test-vm', tenant_id: 'project-a', status: 'ACTIVE', image: { id: 'image-1' } };

function provider({ instance = server, actionError, lookupError } = {}) {
  const calls = [];
  async function fetchOpenStack(_session, service, path, options) {
    calls.push({ service, path, options });
    if (service === 'compute' && path === '/servers/vm-1') {
      if (lookupError) throw lookupError;
      return { server: instance };
    }
    if (service === 'compute' && path === '/servers/vm-1/action') {
      if (actionError) throw actionError;
      return null;
    }
    throw new Error(`Unexpected provider request: ${service} ${path}`);
  }
  return { calls, fetchOpenStack };
}

test('Nova alone decides support regardless of image, metadata, boot source, or VM state', async () => {
  const variants = [
    server,
    { ...server, image: { id: 'deleted-image' } },
    { ...server, image: '' },
    { ...server, image: null },
    { ...server, status: 'SHUTOFF' },
    { ...server, status: 'BUILD' },
    { ...server, os_distro: 'windows', os_admin_user: 'root', hw_qemu_guest_agent: 'no' },
  ];
  for (const instance of variants) {
    const p = provider({ instance });
    const result = await changeInstancePassword(session, server.id, secret, p.fetchOpenStack);
    assert.deepEqual(result, { success: true, instanceName: server.name });
    assert.deepEqual(p.calls.map(({ service, path }) => [service, path]), [
      ['compute', '/servers/vm-1'], ['compute', '/servers/vm-1/action'],
    ]);
    assert.deepEqual(p.calls[1].options, {
      method: 'POST', body: { changePassword: { adminPass: secret } }, responseType: 'none',
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('real Nova client accepts empty 202/204 responses and still rejects non-2xx errors', async (t) => {
  await assert.rejects(
    new Response(null, { status: 202, headers: { 'Content-Type': 'application/json' } }).json(),
    SyntaxError,
  );
  const previousMockSetting = process.env.OS_MOCK;
  process.env.OS_MOCK = 'false';
  const { osFetch: realOsFetch } = await import('../openstack.js?password-response-regression');
  process.env.OS_MOCK = previousMockSetting;

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { logs.push(args.join(' ')); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  });
  const scopedSession = {
    ...session,
    token: 'test-token-not-for-logging',
    catalog: [{ type: 'compute', endpoints: [{ interface: 'public', url: 'https://nova.invalid/v2.1' }] }],
  };
  const cases = [
    { label: '202 empty JSON', response: () => new Response(null, { status: 202, headers: { 'Content-Type': 'application/json' } }), success: true },
    { label: '204 empty', response: () => new Response(null, { status: 204 }), success: true },
    { label: '202 Content-Length 0', response: () => new Response('', { status: 202, headers: { 'Content-Type': 'application/json', 'Content-Length': '0' } }), success: true },
    { label: '400 Nova JSON', response: () => new Response(JSON.stringify({ badRequest: { message: `Invalid ${secret}` } }), { status: 400, headers: { 'Content-Type': 'application/json' } }), code: 'invalid_password' },
    { label: '500 Nova JSON', response: () => new Response(JSON.stringify({ computeFault: { message: `Failure ${secret}` } }), { status: 500, headers: { 'Content-Type': 'application/json' } }), code: 'provider_failure' },
  ];
  for (const scenario of cases) {
    const requests = [];
    let metadata;
    globalThis.fetch = async (_url, options) => {
      requests.push(options);
      if (options.method === 'GET') {
        return new Response(JSON.stringify({ server }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const response = scenario.response();
      metadata = {
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        bodyEmpty: (await response.clone().text()).length === 0,
      };
      return response;
    };
    if (scenario.success) {
      assert.deepEqual(await changeInstancePassword(scopedSession, server.id, secret, realOsFetch),
        { success: true, instanceName: server.name }, scenario.label);
    } else {
      await assert.rejects(changeInstancePassword(scopedSession, server.id, secret, realOsFetch), (error) => {
        assert.equal(error.code, scenario.code, scenario.label);
        assert.equal(error.message.includes(secret), false);
        return true;
      });
    }
    assert.equal(requests.length, 2, scenario.label);
    assert.equal(metadata.status, Number(scenario.label.slice(0, 3)));
    assert.equal(metadata.bodyEmpty, Boolean(scenario.success));
    if (scenario.label === '202 Content-Length 0') assert.equal(metadata.contentLength, '0');
    if (scenario.label === '202 empty JSON') assert.equal(metadata.contentType, 'application/json');
  }
  assert.equal(logs.join('\n').includes(secret), false);
  assert.equal(logs.join('\n').includes(scopedSession.token), false);
});

test('project, role, and input guards prevent Nova action', async () => {
  const cases = [
    [session, { instance: { ...server, tenant_id: 'other-project' } }, secret, 'server_not_found'],
    [{ ...session, project: { id: 'other-project' } }, {}, secret, 'server_not_found'],
    [{ ...session, roles: [] }, {}, secret, 'permission_denied'],
    [session, {}, '', 'invalid_password'],
    [session, { instance: null }, secret, 'server_not_found'],
  ];
  for (const [scope, options, password, code] of cases) {
    const p = provider(options);
    await assert.rejects(changeInstancePassword(scope, server.id, password, p.fetchOpenStack), { code });
    assert.equal(p.calls.some((call) => call.path.endsWith('/action')), false);
  }
});

test('Nova failures are mapped usefully without echoing provider secrets', async () => {
  const cases = [
    [400, '', 'invalid_password'],
    [403, '', 'permission_denied'],
    [409, '', 'invalid_instance_state'],
    [501, '', 'unsupported_operation'],
    [500, 'QEMU guest agent unavailable', 'guest_agent_unavailable'],
    [500, '', 'provider_failure'],
  ];
  for (const [status, reason, code] of cases) {
    const p = provider({ actionError: Object.assign(new Error(`${reason} ${secret}`), { status }) });
    await assert.rejects(changeInstancePassword(session, server.id, secret, p.fetchOpenStack), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.expose, true);
      return true;
    });
    assert.equal(p.calls.filter((call) => call.path.endsWith('/action')).length, 1);
  }
  const missing = provider({ lookupError: Object.assign(new Error(secret), { status: 404 }) });
  await assert.rejects(changeInstancePassword(session, server.id, secret, missing.fetchOpenStack), { code: 'server_not_found' });
});

test('HTTP boundary enforces session, project scope, and audit confidentiality', async (t) => {
  const { createApp } = await import('../app.js');
  const { listAudit } = await import('../audit.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'password-feature-test-session-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (path, cookie, body) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CMP-Request': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

  assert.equal((await post('/api/servers/nope/change-password', null, { password: secret })).status, 401);
  const login = await post('/api/auth/login', null, { username: 'password-feature-test', password: 'demo' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const rows = await (await fetch(base + '/api/servers', { headers: { Cookie: cookie } })).json();
  const [first, second] = rows.servers;
  const response1 = await post(`/api/servers/${first.id}/change-password`, cookie,
    { password: secret, project_id: 'other-project' });
  const response2 = await post(`/api/servers/${second.id}/change-password`, cookie, { password: secret });
  assert.equal(response1.status, 202);
  assert.equal(response2.status, 202);
  assert.deepEqual(await response1.json(), { success: true });
  assert.deepEqual(await response2.json(), { success: true });

  const audit = listAudit({ projectId: 'p-demo', user: 'password-feature-test', limit: 20 })
    .filter((entry) => entry.action === 'instance.change_password').slice(0, 2);
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map((entry) => entry.result), ['success', 'success']);
  assert.equal(audit[0].instance_id, second.id);
  assert.equal(audit[1].instance_name, first.name);
  assert.equal(JSON.stringify(audit).includes(secret), false);
  assert.equal(audit.some((entry) => 'username' in entry), false);

  assert.equal((await post(`/api/servers/${first.id}/change-password`, cookie, { password: '' })).status, 400);
  assert.equal((await post('/api/servers/nonexistent/change-password', cookie, { password: secret })).status, 404);
  assert.equal((await post('/api/auth/switch-project', cookie, { projectId: 'p-devops' })).status, 200);
  assert.equal((await post(`/api/servers/${first.id}/change-password`, cookie, { password: secret })).status, 404);
});
