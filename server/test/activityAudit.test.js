import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('resource mutations retain trusted names once, and authentication remains scoped and secret-free', async (t) => {
  const { createApp } = await import('../app.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'activity-audit-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie = '';
  const suffix = Date.now().toString(36);
  const unverifiedName = `unverified-${suffix}`;
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'GET' ? {} : { 'X-CMP-Request': '1', 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const failed = await request('/auth/login', 'POST', { username: unverifiedName });
  assert.ok(failed.status >= 400);
  const { listAudit } = await import('../audit.js');
  assert.deepEqual(listAudit({ projectId: null, user: unverifiedName, limit: 10 }), []);
  const login = await request('/auth/login', 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const networkName = `audit-net-${suffix}`;
  const networkResponse = await request('/networks', 'POST', {
    name: networkName, cidr: '172.31.251.0/24', gateway_ip: '172.31.251.1', mode: 'isolated',
  });
  assert.equal(networkResponse.status, 200);
  const networkId = (await networkResponse.json()).network.id;
  assert.equal((await request(`/networks/${networkId}`, 'DELETE')).status, 200);

  const volumeName = `audit-volume-${suffix}`;
  const volumeResponse = await request('/volumes', 'POST', { name: volumeName, size: 1 });
  assert.equal(volumeResponse.status, 200);
  const volumeId = (await volumeResponse.json()).volume.id;
  assert.equal((await request(`/volumes/${volumeId}`, 'DELETE')).status, 200);

  const groupName = `audit-sg-${suffix}`;
  const groupResponse = await request('/security-groups', 'POST', { name: groupName });
  assert.equal(groupResponse.status, 200);
  const groupId = (await groupResponse.json()).security_group.id;
  assert.equal((await request(`/security-groups/${groupId}`, 'DELETE')).status, 200);

  const { entries } = await (await request('/audit?limit=500')).json();
  for (const [action, type, name] of [
    ['network.create', 'network', networkName], ['network.delete', 'network', networkName],
    ['volume.create', 'volume', volumeName], ['volume.delete', 'volume', volumeName],
    ['security_group.create', 'security_group', groupName],
    ['security_group.delete', 'security_group', groupName],
  ]) {
    const matching = entries.filter((entry) => entry.action === action && entry.resource_name === name);
    assert.equal(matching.length, 1, `${action} recorded once`);
    assert.equal(matching[0].resource_type, type);
    assert.equal(matching[0].project_id, 'p-demo');
  }
  const signIn = entries.find((entry) => entry.action === 'auth.login' && entry.user === 'admin');
  assert.equal(signIn?.resource_type, 'cmp');
  assert.equal(signIn?.project_id, 'p-demo');
  for (const secretField of ['password', 'token', 'cookie', 'body']) {
    assert.equal(Object.hasOwn(signIn, secretField), false);
  }
  assert.ok(!JSON.stringify(entries).includes(unverifiedName));

  const switched = await request('/auth/switch-project', 'POST', { projectId: 'p-devops' });
  assert.equal(switched.status, 200);
  if (switched.headers.get('set-cookie')) cookie = switched.headers.get('set-cookie').split(';')[0];
  const otherEntries = (await (await request('/audit?limit=500')).json()).entries;
  assert.ok(!otherEntries.some((entry) => entry.resource_id === networkId || entry.resource_id === volumeId));
  assert.equal((await request('/auth/logout', 'POST')).status, 200);
  const logout = listAudit({ projectId: 'p-devops', user: 'admin', limit: 20 })
    .find((entry) => entry.action === 'auth.logout');
  assert.equal(logout?.resource_type, 'cmp');
  assert.equal(logout?.user, 'admin');
});
