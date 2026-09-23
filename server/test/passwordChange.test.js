import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const {
  evaluatePasswordChangeEligibility, parseOpenStackBoolean, listPasswordChangeEligibility,
  changeInstancePassword,
} = await import('../passwordChange.js');

const secret = 'do-not-log-this-password-701';
const session = { project: { id: 'project-a' }, roles: ['member'] };
const server = { id: 'vm-1', name: 'ubuntu-vm', tenant_id: 'project-a', status: 'ACTIVE', image: { id: 'image-1' }, 'OS-EXT-STS:task_state': null };
const image = { id: 'image-1', os_distro: 'ubuntu', os_admin_user: 'ubuntu', hw_qemu_guest_agent: 'yes' };

function provider({ instance = server, sourceImage = image, actionError } = {}) {
  const calls = [];
  async function fetchOpenStack(_session, service, path, options) {
    calls.push({ service, path, options });
    if (service === 'compute' && path === '/servers/vm-1') return { server: instance };
    if (service === 'compute' && path === '/servers/detail') return { servers: [instance] };
    if (service === 'image' && path === '/v2/images/image-1') {
      if (sourceImage instanceof Error) throw sourceImage;
      return sourceImage;
    }
    if (service === 'compute' && path === '/servers/vm-1/action') {
      if (actionError) throw actionError;
      return null;
    }
    throw new Error(`Unexpected provider request: ${service} ${path}`);
  }
  return { calls, fetchOpenStack };
}

test('eligibility requires active Ubuntu, explicit guest agent, and exact ubuntu admin user', () => {
  assert.equal(evaluatePasswordChangeEligibility(server, image).allowed, true);
  for (const value of ['yes', 'true', 'True', '1', true, 1]) assert.equal(parseOpenStackBoolean(value), true);
  for (const value of ['no', 'false', '0', false, 0, undefined, {}, 'maybe']) assert.equal(parseOpenStackBoolean(value), false);
  const cases = [
    [{ ...image, hw_qemu_guest_agent: 'no' }, 'guest_agent_not_enabled'],
    [{ ...image, hw_qemu_guest_agent: undefined }, 'guest_agent_not_enabled'],
    [{ ...image, os_distro: 'windows' }, 'unsupported_distro'],
    [{ ...image, os_admin_user: undefined }, 'admin_user_not_configured'],
    [{ ...image, os_admin_user: 'root' }, 'admin_user_not_configured'],
  ];
  for (const [candidate, reason] of cases) assert.equal(evaluatePasswordChangeEligibility(server, candidate).reason, reason);
  assert.equal(evaluatePasswordChangeEligibility(server, { ...image, os_distro: 'Ubuntu' }).allowed, true);
  assert.equal(evaluatePasswordChangeEligibility({ ...server, status: 'SHUTOFF' }, image).reason, 'invalid_instance_state');
  assert.equal(evaluatePasswordChangeEligibility({ ...server, image: '' }, image).reason, 'unsupported_instance_source');
});

test('eligible password action sends one Nova changePassword request and never returns the secret', async () => {
  const p = provider();
  const result = await changeInstancePassword(session, server.id, secret, p.fetchOpenStack);
  const actions = p.calls.filter((call) => call.path.endsWith('/action'));
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].options, { method: 'POST', body: { changePassword: { adminPass: secret } } });
  assert.deepEqual(result, { accepted: true, username: 'ubuntu', instanceName: server.name });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('ineligible or inaccessible servers never reach Nova action', async () => {
  const cases = [
    [session, { sourceImage: { ...image, hw_qemu_guest_agent: 'no' } }, 'guest_agent_not_enabled'],
    [session, { sourceImage: { ...image, os_admin_user: 'root' } }, 'admin_user_not_configured'],
    [session, { instance: { ...server, status: 'BUILD' } }, 'invalid_instance_state'],
    [session, { instance: { ...server, image: '' } }, 'unsupported_instance_source'],
    [session, { instance: { ...server, tenant_id: 'other-project' } }, 'server_not_found'],
    [{ ...session, project: { id: 'other-project' } }, {}, 'server_not_found'],
    [{ ...session, roles: [] }, {}, 'permission_denied'],
  ];
  for (const [scope, options, code] of cases) {
    const p = provider(options);
    await assert.rejects(changeInstancePassword(scope, server.id, secret, p.fetchOpenStack), (error) => error.code === code);
    assert.equal(p.calls.some((call) => call.path.endsWith('/action')), false);
  }
});

test('unavailable image and malicious provider errors remain safe', async () => {
  const missing = provider({ sourceImage: Object.assign(new Error('missing'), { status: 404 }) });
  await assert.rejects(changeInstancePassword(session, server.id, secret, missing.fetchOpenStack), { code: 'image_not_found' });
  const broken = provider({ sourceImage: Object.assign(new Error('unavailable'), { status: 503 }) });
  await assert.rejects(changeInstancePassword(session, server.id, secret, broken.fetchOpenStack), { code: 'image_metadata_unavailable' });
  for (const status of [400, 500, 501]) {
    const p = provider({ actionError: Object.assign(new Error(`Provider echoed ${secret} and guest agent unavailable`), { status }) });
    await assert.rejects(changeInstancePassword(session, server.id, secret, p.fetchOpenStack), (error) => {
      assert.equal(error.message.includes(secret), false);
      return status === 501 ? error.code === 'guest_agent_unavailable' : true;
    });
  }
});

test('bulk capability lookup fetches each distinct image once and stays project scoped', async () => {
  const calls = [];
  const other = { ...server, id: 'vm-2', name: 'other-vm' };
  const foreign = { ...server, id: 'vm-3', tenant_id: 'other-project' };
  async function fetchOpenStack(_session, service, path) {
    calls.push({ service, path });
    return service === 'compute' ? { servers: [server, other, foreign] } : image;
  }
  const capabilities = await listPasswordChangeEligibility(session, fetchOpenStack);
  assert.deepEqual(Object.keys(capabilities).sort(), ['vm-1', 'vm-2']);
  assert.equal(capabilities['vm-1'].allowed, true);
  assert.equal(calls.filter((call) => call.service === 'image').length, 1);
});

test('HTTP boundary enforces login, project, metadata, audit safety, and no password in response', async (t) => {
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
  const [eligible, agentDisabled] = rows.servers;
  const capabilityResponse = await fetch(base + '/api/servers/password-change-eligibility', { headers: { Cookie: cookie } });
  assert.equal(capabilityResponse.status, 200);
  const capabilityData = await capabilityResponse.json();
  assert.equal(capabilityData.capabilities[eligible.id].allowed, true);
  assert.equal(capabilityData.capabilities[agentDisabled.id].reason, 'guest_agent_not_enabled');

  const accepted = await post(`/api/servers/${eligible.id}/change-password`, cookie,
    { password: secret, project_id: 'other-project', os_distro: 'windows', hw_qemu_guest_agent: 'no' });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true, username: 'ubuntu' });
  const rejected = await post(`/api/servers/${agentDisabled.id}/change-password`, cookie,
    { password: secret, os_distro: 'ubuntu', hw_qemu_guest_agent: 'yes', os_admin_user: 'ubuntu' });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'guest_agent_not_enabled');

  const audit = listAudit({ projectId: 'p-demo', user: 'password-feature-test', limit: 20 })
    .filter((entry) => entry.action === 'instance.change_password');
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map((entry) => entry.result), ['failure', 'success']);
  assert.equal(audit[0].instance_id, agentDisabled.id);
  assert.equal(audit[1].instance_name, eligible.name);
  assert.equal(JSON.stringify(audit).includes(secret), false);

  assert.equal((await post(`/api/servers/${eligible.id}/change-password`, cookie, { password: '' })).status, 400);
  assert.equal((await post('/api/servers/nonexistent/change-password', cookie, { password: secret })).status, 404);
  assert.equal((await post('/api/auth/switch-project', cookie, { projectId: 'p-devops' })).status, 200);
  assert.equal((await post(`/api/servers/${eligible.id}/change-password`, cookie, { password: secret })).status, 404);
});
