import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OS_MOCK = 'true';
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';
const testData = mkdtempSync(path.join(tmpdir(), 'cmp-classification-test-'));
process.env.DATA_DIR = testData;
test.after(() => { closeClassificationDb(); rmSync(testData, { recursive: true, force: true }); });

const { openClassificationDb, classificationDb, closeClassificationDb } = await import('../classificationDb.js');
const { catalog, createLabel, createTag, updateLabel, updateTag, deleteLabel, deleteTag,
  validateSelection, replaceAssignments, assignmentsForInstances, pruneMissingInstances,
  removeInstanceAssignments } = await import('../classifications.js');

test('schema starts empty, enforces case-insensitive project uniqueness and one value per label', () => {
  const db = openClassificationDb(':memory:');
  assert.deepEqual(catalog('A', db), { labels: [], tags: [] });
  const label = createLabel('A', 'alice', { name: ' Environment ', values: [
    { value: 'Production', color: '#ef4444' }, { value: 'Development', color: '#3b82f6' }] }, db);
  assert.equal(label.name, 'Environment');
  assert.equal(label.values[0].color, '#3B82F6');
  assert.throws(() => createLabel('A', 'alice', { name: 'environment', values: [{ value: 'Other', color: '#123456' }] }, db),
    { status: 409, code: 'classification_duplicate' });
  assert.doesNotThrow(() => createLabel('B', 'bob', { name: 'Environment', values: [{ value: 'Production', color: '#123456' }] }, db));
  assert.throws(() => createLabel('A', 'alice', { name: 'Role', values: [
    { value: 'Web', color: '#123456' }, { value: 'web', color: '#654321' }] }, db), { status: 409 });
  const tag = createTag('A', 'alice', { name: 'Customer Facing', color: '#ffffff' }, db);
  assert.equal(tag.color, '#FFFFFF');
  assert.throws(() => createTag('A', 'alice', { name: 'customer facing', color: '#123456' }, db), { status: 409 });
  assert.throws(() => createTag('A', 'alice', { name: 'Unsafe', color: 'url(x)' }, db),
    { status: 400, code: 'classification_color_invalid' });
  assert.throws(() => validateSelection('A', { labels: [
    { label_id: label.id, value_id: label.values[0].id }, { label_id: label.id, value_id: label.values[1].id }],
  tag_ids: [] }, db), { status: 400, code: 'classification_invalid' });
  assert.throws(() => validateSelection('B', { labels: [], tag_ids: [tag.id] }, db),
    { status: 400, code: 'classification_invalid' });
  db.close();
});

test('SQLite migration persists customer definitions across reopen without seeding defaults', () => {
  const location = path.join(testData, 'persist-classification.sqlite');
  const first = openClassificationDb(location);
  assert.deepEqual(catalog('A', first), { labels: [], tags: [] });
  createTag('A', 'alice', { name: 'Customer Facing', color: '#ABCDEF' }, first);
  first.close();
  const reopened = openClassificationDb(location);
  assert.equal(catalog('A', reopened).tags[0].name, 'Customer Facing');
  assert.deepEqual(catalog('B', reopened), { labels: [], tags: [] });
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1);
  reopened.close();
});

test('assignments remain ID-linked through rename/recolor; deletion and stale cleanup affect no VM definitions', () => {
  const db = openClassificationDb(':memory:');
  const label = createLabel('A', 'alice', { name: 'Application Tier', values: [{ value: 'Backend Services', color: '#123456' }] }, db);
  const tag = createTag('A', 'alice', { name: 'Critical', color: '#ef4444' }, db);
  const otherTag = createTag('A', 'alice', { name: 'Temporary', color: '#888888' }, db);
  const selection = { labels: [{ label_id: label.id, value_id: label.values[0].id }], tag_ids: [tag.id, otherTag.id] };
  const first = replaceAssignments('A', 'vm-1', selection, db);
  assert.deepEqual(first.diff.labels.added, ['Application Tier: Backend Services']);
  assert.deepEqual(first.diff.tags.added, ['Critical', 'Temporary']);
  assert.deepEqual(replaceAssignments('A', 'vm-1', selection, db).diff.labels.added, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instance_label_assignments').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instance_tag_assignments').get().n, 2);
  updateLabel('A', label.id, { name: 'Role', values: [{ ...label.values[0], value: 'API', color: '#ffffff' }] }, db);
  updateTag('A', tag.id, { name: 'Priority', color: '#550088' }, db);
  const assigned = assignmentsForInstances('A', ['vm-1'], db)['vm-1'];
  assert.equal(assigned.labels[0].label_name, 'Role');
  assert.equal(assigned.labels[0].value, 'API');
  assert.equal(assigned.labels[0].color, '#FFFFFF');
  assert.equal(assigned.tags.find((item) => item.id === tag.id).color, '#550088');
  assert.deepEqual(assignmentsForInstances('B', ['vm-1'], db)['vm-1'], { labels: [], tags: [] });
  assert.throws(() => deleteTag('A', tag.id, false, db), { status: 409 });
  assert.equal(deleteTag('A', tag.id, true, db).assignment_count, 1);
  assert.equal(assignmentsForInstances('A', ['vm-1'], db)['vm-1'].tags.length, 1);
  assert.equal(pruneMissingInstances('A', [], db), 1);
  assert.equal(catalog('A', db).labels.length, 1);
  assert.equal(catalog('A', db).tags.length, 1);
  replaceAssignments('A', 'vm-2', selectionFromCurrent(label, otherTag), db);
  removeInstanceAssignments('A', 'vm-2', db);
  assert.equal(assignmentsForInstances('A', ['vm-2'], db)['vm-2'].labels.length, 0);
  assert.equal(deleteLabel('A', label.id, true, db).value_count, 1);
  db.close();
});

function selectionFromCurrent(label, tag) {
  return { labels: [{ label_id: label.id, value_id: label.values[0].id }], tag_ids: [tag.id] };
}

test('HTTP API derives project from session, checks VM ownership, and never changes Nova metadata or tags', async (t) => {
  const { createApp } = await import('../app.js');
  const { mockFetch } = await import('../mock.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'classification-api-test-secret' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const request = async (route, cookie, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { 'X-CMP-Request': '1', 'Content-Type': 'application/json' } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = await request('/auth/login', null, 'POST', { username: 'admin', password: 'demo' });
  assert.equal(login.status, 200);
  const cookie = login.cookie;
  const empty = await request('/classifications/catalog', cookie);
  assert.deepEqual(empty.body, { labels: [], tags: [] });
  const server = (await request('/servers', cookie)).body.servers[0];
  const novaBefore = mockFetch('compute', 'GET', `/servers/${server.id}`, null, 'p-demo').server;
  const oldMetadata = structuredClone(novaBefore.metadata);
  const oldTags = structuredClone(novaBefore.tags);
  const labelResult = await request('/classifications/labels', cookie, 'POST', { name: 'Environment', values: [
    { value: 'Production', color: '#EF4444' }] });
  assert.equal(labelResult.status, 201);
  const label = labelResult.body.label;
  const tagResult = await request('/classifications/tags', cookie, 'POST', { name: 'Critical', color: '#B91C1C' });
  assert.equal(tagResult.status, 201);
  const tag = tagResult.body.tag;
  assert.equal((await request('/classifications/labels', cookie)).body.labels[0].id, label.id);
  assert.equal((await request('/classifications/tags', cookie)).body.tags[0].id, tag.id);
  const { listAudit } = await import('../audit.js');
  assert.ok(listAudit({ projectId: 'p-demo', user: 'admin', limit: 10 }).some((event) =>
    event.action === 'tag.create' && event.provider === 'cmp' && event.resource_id === tag.id));
  const assignment = { labels: [{ label_id: label.id, value_id: label.values[0].id }], tag_ids: [tag.id] };
  assert.equal((await request(`/servers/${server.id}/classifications`, cookie, 'PUT', assignment)).status, 200);
  const refreshed = (await request(`/servers/${server.id}`, cookie)).body.server;
  assert.equal(refreshed.classification.labels[0].value, 'Production');
  assert.equal(refreshed.classification.tags[0].name, 'Critical');
  const novaAfter = mockFetch('compute', 'GET', `/servers/${server.id}`, null, 'p-demo').server;
  assert.deepEqual(novaAfter.metadata, oldMetadata);
  assert.deepEqual(novaAfter.tags, oldTags);
  const activity = (await request(`/servers/${server.id}/activity`, cookie)).body.entries;
  assert.ok(activity.some((item) => item.action === 'instance.labels.update'));
  assert.ok(activity.some((item) => item.action === 'instance.tags.update'));
  const image = (await request('/images', cookie)).body.images.find((item) => item.os_distro === 'rocky');
  const network = (await request('/available-networks', cookie)).body.networks.find((item) => item.project_id === 'p-demo' && item.subnet_details?.length);
  const createPayload = { name: 'cmp-classified-vm', flavorRef: 'f-small', imageRef: image.id,
    interfaces: [{ network_id: network.id, subnet_id: network.subnet_details[0].id, ip_address: null }], classification: assignment };
  const created = await request('/servers', cookie, 'POST', createPayload);
  assert.equal(created.status, 202);
  assert.equal(created.body.classification_warning, false);
  const createdId = created.body.server.id;
  assert.equal((await request(`/servers/${createdId}`, cookie)).body.server.classification.tags[0].id, tag.id);
  const createdNova = mockFetch('compute', 'GET', `/servers/${createdId}`, null, 'p-demo').server;
  assert.deepEqual(createdNova.metadata, {});
  assert.deepEqual(createdNova.tags, []);
  assert.equal((await request('/servers', cookie, 'POST', { ...createPayload, name: 'rejected-vm',
    classification: { labels: [], tag_ids: ['foreign-tag'] } })).status, 400);
  assert.equal((await request(`/servers/${createdId}`, cookie, 'DELETE')).status, 200);
  assert.equal(assignmentsForInstances('p-demo', [createdId])[createdId].tags.length, 0);
  assert.equal((await request('/classifications/catalog', cookie)).body.tags.length, 1);
  classificationDb().exec(`CREATE TRIGGER classification_failure BEFORE INSERT ON instance_label_assignments
    BEGIN SELECT RAISE(ABORT, 'injected assignment failure'); END;`);
  const warning = await request('/servers', cookie, 'POST', { ...createPayload, name: 'classification-warning-vm' });
  classificationDb().exec('DROP TRIGGER classification_failure');
  assert.equal(warning.status, 202);
  assert.equal(warning.body.classification_warning, true);
  assert.equal(mockFetch('compute', 'GET', `/servers/${warning.body.server.id}`, null, 'p-demo').server.id, warning.body.server.id);
  assert.equal((await request(`/servers/${warning.body.server.id}`, cookie, 'DELETE')).status, 200);
  const foreign = mockFetch('compute', 'POST', '/servers', { server: { name: 'foreign-classification-vm',
    flavorRef: 'f-small', imageRef: 'unused' } }, 'p-devops').server;
  assert.equal((await request(`/servers/${foreign.id}/classifications`, cookie, 'PUT', assignment)).status, 404);
  assert.equal((await request(`/servers/${foreign.id}/classifications`, cookie)).status, 404);
  assert.equal((await request('/auth/switch-project', cookie, 'POST', { projectId: 'p-devops' })).status, 200);
  assert.deepEqual((await request('/classifications/catalog', cookie)).body, { labels: [], tags: [] });
  assert.equal((await request(`/servers/${server.id}/classifications`, cookie, 'PUT', assignment)).status, 404);
  assert.equal((await request(`/servers/${foreign.id}/classifications`, cookie, 'PUT', assignment)).status, 400);
  const devTag = (await request('/classifications/tags', cookie, 'POST', { name: 'Far Page', color: '#334455' })).body.tag;
  let tail;
  for (let index = 0; index < 1005; index++) {
    tail = mockFetch('compute', 'POST', '/servers', { server: { name: `paged-${index}`,
      flavorRef: 'f-small', imageRef: image.id, networks: [] } }, 'p-devops').server;
  }
  assert.equal((await request(`/servers/${tail.id}/classifications`, cookie, 'PUT', { labels: [], tag_ids: [devTag.id] })).status, 200);
  const all = (await request('/servers', cookie)).body.servers;
  assert.ok(all.length > 1000);
  assert.equal(all.find((item) => item.id === tail.id).classification.tags[0].name, 'Far Page');
});

test('assigned label value removal requires confirmation and cascades only CMP assignments', () => {
  const db = openClassificationDb(':memory:');
  const label = createLabel('A', 'alice', { name: 'Environment', values: [
    { value: 'Production', color: '#111111' }, { value: 'Staging', color: '#222222' }] }, db);
  replaceAssignments('A', 'vm-1', { labels: [{ label_id: label.id, value_id: label.values[0].id }], tag_ids: [] }, db);
  const kept = label.values.filter((item) => item.id !== label.values[0].id);
  assert.throws(() => updateLabel('A', label.id, { name: label.name, values: kept }, db),
    { status: 409, code: 'classification_in_use' });
  assert.equal(updateLabel('A', label.id, { name: label.name, values: kept, confirm_removals: true }, db).removedAssignments, 1);
  assert.deepEqual(assignmentsForInstances('A', ['vm-1'], db)['vm-1'], { labels: [], tags: [] });
  db.close();
});

test('large VM lists join assignments in bounded batches, not per instance', () => {
  const db = openClassificationDb(':memory:');
  const tag = createTag('A', 'alice', { name: 'Visible', color: '#123456' }, db);
  const insert = db.prepare(`INSERT INTO instance_tag_assignments(project_id,instance_id,tag_id,created_at)
    VALUES('A',?,?,?)`);
  const ids = Array.from({ length: 1201 }, (_, index) => `vm-${index}`);
  for (const id of ids) insert.run(id, tag.id, '2026-01-01T00:00:00Z');
  let queries = 0;
  const counted = { prepare(sql) { queries++; return db.prepare(sql); } };
  const assignments = assignmentsForInstances('A', ids, counted);
  assert.equal(Object.keys(assignments).length, 1201);
  assert.equal(assignments['vm-1200'].tags[0].name, 'Visible');
  assert.equal(queries, 6); // Two joins for each 500-ID batch.
  db.close();
});

test('classification storage has no OpenStack, Billing, or automation integration', () => {
  for (const file of ['../classifications.js', '../classificationDb.js', '../routes/classifications.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /osFetch|billing(?:Client|Service|Fetch)|backup|automation/i);
  }
  const compute = readFileSync(new URL('../routes/compute.js', import.meta.url), 'utf8');
  assert.doesNotMatch(compute, /labelsToMetadata|server\.tags\s*=|server\.metadata\s*=/);
});
