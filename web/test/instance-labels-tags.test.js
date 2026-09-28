import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { createServer } from 'vite';
import { classificationChips, emptySelection, foregroundForColor, matchesClassificationFilters,
  matchesClassificationSearch, selectionFromClassification } from '../src/classification.js';
import { translate } from '../src/i18n/index.js';
import { formatActivity } from '../src/activityFormatter.js';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const environment = { label_id: 'environment', label_name: 'Environment', value_id: 'production',
  value: 'Production', color: '#EF4444' };
const critical = { id: 'critical', name: 'Critical', color: '#111827' };

test('CMP classifications use ID-based AND filters and compact customer-colored chips', () => {
  const a = { name: 'vm-a', classification: { labels: [environment], tags: [critical] } };
  const b = { name: 'vm-b', classification: { labels: [{ ...environment, value_id: 'development' }], tags: [critical] } };
  const filters = [{ kind: 'label', label_id: 'environment', value_id: 'production' },
    { kind: 'tag', tag_id: 'critical' }];
  assert.equal(matchesClassificationFilters(a.classification, filters), true);
  assert.equal(matchesClassificationFilters(b.classification, filters), false);
  assert.equal(matchesClassificationSearch(a, 'Production'), true);
  assert.equal(matchesClassificationSearch(a, 'Critical'), true);
  assert.equal(matchesClassificationSearch(a, 'hidden'), false);
  assert.deepEqual(classificationChips(a.classification, 1).visible[0], {
    id: 'production', text: 'Production', title: 'Environment: Production', color: '#EF4444',
  });
  assert.equal(classificationChips(a.classification, 1).remaining, 1);
  assert.deepEqual(selectionFromClassification(a.classification), {
    labels: [{ label_id: 'environment', value_id: 'production' }], tag_ids: ['critical'],
  });
  assert.deepEqual(emptySelection(), { labels: [], tag_ids: [] });
  assert.equal(foregroundForColor('#111827'), '#FFFFFF');
  assert.equal(foregroundForColor('#FDE68A'), '#111827');
  const many = Array.from({ length: 500 }, (_, index) => ({ ...a, name: `vm-${index}`,
    classification: index === 241 ? a.classification : b.classification }));
  assert.equal(many.filter((server) => matchesClassificationFilters(server.classification, filters)).length, 1);
});

test('create and detail reuse project catalog picker and never use Nova metadata/tag endpoints', () => {
  const create = source('../src/pages/Instances.jsx');
  const detail = source('../src/pages/InstanceDetail.jsx');
  const picker = source('../src/components/ClassificationPicker.jsx');
  assert.match(create, /<ClassificationPicker /);
  assert.match(detail, /<ClassificationPicker/);
  assert.match(create, /classification,/);
  assert.match(detail, /\/servers\/\$\{encodedId\}\/classifications/);
  assert.match(create, /api\('\/servers'\)/);
  assert.match(picker, /selection\.tag_ids/);
  for (const file of [create, detail]) assert.doesNotMatch(file, /\/metadata|\/tags|instanceLabelsTags/);
});

test('new classifications and semantic activity labels translate without translating customer data', () => {
  for (const locale of ['vi', 'en']) {
    for (const key of ['classification.title', 'classification.labels.create', 'classification.tags.create',
      'instance.classification.none', 'instance.filters.title', 'navigation.labelsTags',
      'instance.activity.action.instance.labels.update', 'instance.activity.action.instance.tags.update']) {
      assert.notEqual(translate(locale, key), key);
    }
    const t = (key) => translate(locale, key);
    const activity = formatActivity({ action: 'instance.labels.update', result: 'success',
      details: { added: ['Environment'], changed: ['Role'], removed: [], secret: 'NEVER-SHOW' } }, t);
    assert.equal(activity.semantic, true);
    assert.equal(activity.details.includes('NEVER-SHOW'), false);
    assert.equal(activity.details.includes('Environment'), true);
    const definitionEvent = formatActivity({ action: 'label.create', result: 'success' }, t);
    assert.equal(definitionEvent.semantic, true);
    assert.notEqual(definitionEvent.action, 'label.create');
  }
});

test('shared picker renders one optional value per Label and multiple customer-colored Tags', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { default: ClassificationPicker } = await vite.ssrLoadModule('/src/components/ClassificationPicker.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const catalog = { labels: [{ id: 'environment', name: 'Environment', values: [
      { id: 'production', value: 'Production', color: '#EF4444' },
      { id: 'development', value: 'Development', color: '#3B82F6' }] }],
    tags: [critical, { id: 'temporary', name: 'Temporary', color: '#E5E7EB' }] };
    const markup = renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(StaticRouter, { location: '/instances' }, React.createElement(ClassificationPicker,
        { catalog, selection: { labels: [{ label_id: 'environment', value_id: 'production' }],
          tag_ids: ['critical'] }, onChange: () => {} }))));
    assert.match(markup, /<option value="production" selected="">Production<\/option>/);
    assert.match(markup, /<option value="development">Development<\/option>/);
    assert.match(markup, /Critical/);
    assert.match(markup, /Temporary/);
    assert.match(markup, /background-color:#111827/);
    const empty = renderToStaticMarkup(React.createElement(LocaleProvider, null,
      React.createElement(StaticRouter, { location: '/instances' }, React.createElement(ClassificationPicker,
        { catalog: { labels: [], tags: [] }, selection: emptySelection(), onChange: () => {} }))));
    assert.match(empty, /href="\/labels-tags"/);
  } finally { await vite.close(); }
});
