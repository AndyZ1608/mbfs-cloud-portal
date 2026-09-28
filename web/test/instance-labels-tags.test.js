import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { instanceLabels, instanceTags, listChips, matchesInstanceFilters } from '../src/instanceLabelsTags.js';
import { translate } from '../src/i18n/index.js';
import { formatActivity } from '../src/activityFormatter.js';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('list uses existing Nova detailed server payload for search and composable filters', () => {
  const a = { name: 'vm-a', metadata: { 'cmp.label.environment': 'production', 'cmp.label.application': 'ERP', other: 'hidden' }, tags: ['database'] };
  const b = { name: 'vm-b', metadata: { 'cmp.label.environment': 'development' }, tags: ['database'] };
  assert.deepEqual(instanceLabels(a), { environment: 'production', application: 'ERP' });
  assert.deepEqual(instanceTags(a), ['database']);
  const filters = [{ kind: 'label', key: 'environment', value: 'production' }, { kind: 'tag', tag: 'database' }];
  assert.equal(matchesInstanceFilters(a, '', filters), true);
  assert.equal(matchesInstanceFilters(b, '', filters), false);
  assert.equal(matchesInstanceFilters(a, 'ERP', []), true);
  assert.equal(matchesInstanceFilters(a, 'hidden', []), false);
  assert.equal(listChips(a).visible.length, 2);
  assert.equal(listChips(a).remaining, 1);
  assert.match(source('../src/pages/Instances.jsx'), /api\('\/servers'\)/);
  assert.doesNotMatch(source('../src/pages/Instances.jsx'), /servers\/\$\{s\.id\}\/metadata/);
  const largeList = Array.from({ length: 500 }, (_, index) => ({ name: `vm-${index}`,
    metadata: { 'cmp.label.environment': index === 241 ? 'production' : 'development' },
    tags: index === 241 ? ['database'] : [] }));
  assert.equal(largeList.filter((server) => matchesInstanceFilters(server, '', filters)).length, 1);
});

test('create and detail share the editor; labels and tags have vi/en UI and activity labels', () => {
  const create = source('../src/pages/Instances.jsx');
  const detail = source('../src/pages/InstanceDetail.jsx');
  assert.match(create, /<details className="vm-create-labels-tags">/);
  assert.match(create, /\.\.\.labelsTags/);
  assert.match(detail, /api\(`\/servers\/\$\{encodedId\}\/labels-tags`\)/);
  assert.match(detail, /method: 'PUT', body: \{ \.\.\.payload, expected: originalLabelsTags \}/);
  for (const locale of ['vi', 'en']) {
    for (const key of ['instance.labelsTags.title', 'instance.labelsTags.edit', 'instance.labelsTags.save',
      'instance.labels.empty', 'instance.tags.empty', 'instance.filters.title',
      'instance.activity.action.instance.labels.update', 'instance.activity.action.instance.tags.update']) {
      assert.notEqual(translate(locale, key), key);
    }
    const t = (key) => translate(locale, key);
    const activity = formatActivity({ action: 'instance.labels.update', result: 'success',
      details: { added: ['owner'], changed: ['environment'], removed: ['backup'], secret: 'NEVER-SHOW' } }, t);
    assert.equal(activity.semantic, true);
    assert.ok(activity.action.includes(locale === 'en' ? 'Labels updated' : 'Labels'));
    assert.equal(activity.details.includes('NEVER-SHOW'), false);
  }
});
