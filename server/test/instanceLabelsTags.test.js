import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

test('label normalization, native tags and minimal diff keep their distinct semantics', async () => {
  const { normalizeLabels, normalizeTags, labelsToMetadata, labelsFromMetadata, labelTagDiff } = await import('../instanceLabelsTags.js');
  assert.deepEqual({ ...normalizeLabels({ Environment: 'Production', application: 'ERP' }) },
    { environment: 'Production', application: 'ERP' });
  assert.deepEqual(labelsToMetadata({ environment: 'Production' }), { 'cmp.label.environment': 'Production' });
  assert.deepEqual({ ...labelsFromMetadata({ os_type: 'linux', 'cmp.label.environment': 'Production' }) }, { environment: 'Production' });
  assert.throws(() => normalizeLabels({ environment: 'a', ENVIRONMENT: 'b' }), { code: 'label_duplicate' });
  assert.throws(() => normalizeLabels({ 'cmp.internal.foo': 'bar' }), { code: 'label_invalid' });
  assert.deepEqual(normalizeTags(['Database', 'database']), ['Database', 'database']);
  assert.throws(() => normalizeTags(['same', 'same']), { code: 'tag_duplicate' });
  assert.deepEqual(labelTagDiff({ environment: 'development', application: 'ERP', backup: 'daily' },
    ['database', 'temporary'], { environment: 'production', application: 'ERP', owner: 'team' },
    ['database', 'customer-facing']), {
    labels: { added: ['owner'], changed: ['environment'], removed: ['backup'] },
    tags: { added: ['customer-facing'], removed: ['temporary'] },
  });
});

test('create, edit, list, audit and project boundary use Nova-backed labels and tags', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'labels-tags-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  let cookie = '';
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { 'X-CMP-Request': '1', 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = async (path) => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const login = await request('/auth/login', 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const image = (await read('/images')).images[0];
  const network = (await read('/available-networks')).networks.find((item) => item.project_id === 'p-demo' && item.subnet_details?.length);
  const create = await request('/servers', 'POST', { name: 'labels-tags-vm', flavorRef: 'f-small', imageRef: image.id,
    interfaces: [{ network_id: network.id, subnet_id: network.subnet_details[0].id, ip_address: null }],
    labels: { Environment: 'Production', application: 'ERP' }, tags: ['database', 'temporary'] });
  assert.equal(create.status, 202);
  const id = (await create.json()).server.id;
  const provider = mockFetch('compute', 'GET', `/servers/${id}`, undefined, 'p-demo').server;
  assert.equal(provider.metadata['cmp.label.environment'], 'Production');
  assert.equal(provider.metadata['cmp.label.application'], 'ERP');
  assert.deepEqual(provider.tags, ['database', 'temporary']);
  assert.deepEqual((await read(`/servers/${id}/labels-tags`)).tags, ['database', 'temporary']);

  // Regression: changing/removing CMP labels must never replace other Nova metadata.
  provider.metadata.foo = 'bar';
  provider.metadata.automation = 'ansible';
  provider.metadata['cmp.label.backup'] = 'daily';
  const update = await request(`/servers/${id}/labels-tags`, 'PUT', {
    labels: { environment: 'staging', application: 'ERP' }, tags: ['database', 'customer-facing'],
  });
  assert.equal(update.status, 200);
  const changed = mockFetch('compute', 'GET', `/servers/${id}`, undefined, 'p-demo').server;
  assert.deepEqual(changed.metadata, { 'cmp.label.environment': 'staging', 'cmp.label.application': 'ERP',
    foo: 'bar', automation: 'ansible' });
  assert.deepEqual(changed.tags, ['database', 'customer-facing']);
  // A stale editor must not delete a CMP label or tag added externally meanwhile.
  changed.metadata['cmp.label.owner'] = 'external-team';
  const stale = await request(`/servers/${id}/labels-tags`, 'PUT', {
    labels: { environment: 'production', application: 'ERP' }, tags: ['database'],
    expected: { labels: { environment: 'staging', application: 'ERP' }, tags: ['database', 'customer-facing'] },
  });
  assert.equal(stale.status, 409);
  assert.equal(changed.metadata['cmp.label.owner'], 'external-team');
  assert.deepEqual(changed.tags, ['database', 'customer-facing']);
  const listing = (await read('/servers')).servers.find((item) => item.id === id);
  assert.equal(listing.metadata['cmp.label.environment'], 'staging');
  assert.deepEqual(listing.tags, ['database', 'customer-facing']);
  const activity = (await read(`/servers/${id}/activity`)).entries;
  assert.ok(activity.some((event) => event.action === 'instance.labels.update' && event.details.changed.includes('environment')));
  assert.ok(activity.some((event) => event.action === 'instance.tags.update' && event.details.added.includes('customer-facing')));
  assert.equal(JSON.stringify(activity).includes('ansible'), false);

  const foreign = mockFetch('compute', 'POST', '/servers', { server: { name: 'foreign-labels', flavorRef: 'f-small',
    metadata: { 'cmp.label.environment': 'secret' }, tags: ['foreign'] } }, 'p-devops').server;
  assert.equal((await request(`/servers/${foreign.id}/labels-tags`)).status, 404);
  assert.equal((await request(`/servers/${foreign.id}/labels-tags`, 'PUT', {
    labels: { environment: 'leak' }, tags: ['changed'], project_id: 'p-devops',
  })).status, 404);
  const stillForeign = mockFetch('compute', 'GET', `/servers/${foreign.id}`, undefined, 'p-devops').server;
  assert.equal(stillForeign.metadata['cmp.label.environment'], 'secret');
  assert.deepEqual(stillForeign.tags, ['foreign']);
});
