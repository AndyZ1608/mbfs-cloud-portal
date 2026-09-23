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
    assert.deepEqual(p.calls[1].options, { method: 'POST', body: { changePassword: { adminPass: secret } } });
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
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
