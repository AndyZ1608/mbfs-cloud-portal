import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { matchesClassificationFilters } from '../src/classification.js';
import { matchesResourceName, nameSuggestions } from '../src/resourceNameFilter.js';
import { translate } from '../src/i18n/index.js';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('display-name search is case-insensitive substring only, including mid-string', () => {
  const network = { name: 'NSW_UAT_INT_APP_NODE_NET', id: 'new-in-uuid', cidr: 'NEW', description: 'NEW' };
  for (const query of ['uat', 'UAT', 'int_app', 'node', 'NeT']) {
    assert.equal(matchesResourceName(network, query), true, query);
  }
  for (const query of ['new', 'NEW', 'NeW']) {
    assert.equal(matchesResourceName({ name: 'NSW_UAT_DMZ_NET_NEW' }, query), true);
  }
  assert.equal(matchesResourceName(network, 'new'), false);
  assert.equal(matchesResourceName({ name: 'APP-NET', id: 'new-uuid', fixed_ip: 'new-ip',
    classification: { tags: [{ name: 'new' }] } }, 'new'), false);
  assert.equal(matchesResourceName(network, ''), true);
  assert.deepEqual(['APP-UAT-01', 'DB-UAT-01', 'WINDOWS-TEST', 'PROD-WEB-NEW']
    .filter((name) => matchesResourceName({ name }, 'UAT')), ['APP-UAT-01', 'DB-UAT-01']);
});

test('suggestions rank prefixes first, alphabetize within rank, deduplicate and limit to eight', () => {
  const names = ['NSW_UAT_DMZ_NET_NEW', 'NSW_UAT_INT_APP_NEW', 'BACKUP-New-Network',
    'NEW-DB-NET', 'NEW-APP-NET', 'NEW-APP-NET'];
  assert.deepEqual(nameSuggestions(names.map((name) => ({ name })), 'new'),
    ['NEW-APP-NET', 'NEW-DB-NET', 'BACKUP-New-Network', 'NSW_UAT_DMZ_NET_NEW', 'NSW_UAT_INT_APP_NEW']);
  assert.deepEqual(nameSuggestions(names.map((name) => ({ name })), ''), []);
  assert.deepEqual(nameSuggestions(names.map((name) => ({ name })), 'absent'), []);
  assert.equal(nameSuggestions(Array.from({ length: 100 }, (_, index) => ({ name: `NEW-${index}` })), 'new').length, 8);
});

test('name AND classification filters work; clearing name preserves classification', () => {
  const servers = [
    { name: 'PROD-WEB-01', classification: { labels: [{ label_id: 'env', value_id: 'production' }] } },
    { name: 'DEV-WEB-01', classification: { labels: [{ label_id: 'env', value_id: 'development' }] } },
    { name: 'PROD-DB-01', classification: { labels: [{ label_id: 'env', value_id: 'production' }] } },
  ];
  const filters = [{ kind: 'label', label_id: 'env', value_id: 'production' }];
  const shown = (query) => servers.filter((item) => matchesResourceName(item, query)
    && matchesClassificationFilters(item.classification, filters)).map((item) => item.name);
  assert.deepEqual(shown('web'), ['PROD-WEB-01']);
  assert.deepEqual(shown(''), ['PROD-WEB-01', 'PROD-DB-01']);
});

test('search operates on the complete authorized list, beyond an initial visible page', () => {
  const authorized = Array.from({ length: 1200 }, (_, index) => ({ name: `NET-${index}` }));
  authorized[1100].name = 'SPECIAL-NET-NEW';
  assert.deepEqual(authorized.filter((item) => matchesResourceName(item, 'new')).map((item) => item.name), ['SPECIAL-NET-NEW']);
  assert.deepEqual(nameSuggestions(authorized, 'new'), ['SPECIAL-NET-NEW']);
  const networkSource = source('../src/pages/Networks.jsx');
  const instanceSource = source('../src/pages/Instances.jsx');
  assert.match(networkSource, /nets\?\.filter\(\(network\) => matchesResourceName\(network, nameQuery\)\)/);
  assert.match(instanceSource, /servers\.filter\(\(s\) => \{/);
  assert.match(networkSource, /\{shown\.map\(\(n\) => \(/);
  assert.doesNotMatch(instanceSource, /matchesClassificationSearch\(s, query\)|serverIps\(s\)\.some/);
});

test('shared combobox renders name-only suggestions and localized labels', async () => {
  for (const locale of ['vi', 'en']) {
    for (const key of ['instances.nameFilterPlaceholder', 'networks.nameFilterPlaceholder',
      'resourceName.clear', 'resourceName.noMatches']) assert.notEqual(translate(locale, key), key);
  }
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { default: ResourceNameFilter } = await vite.ssrLoadModule('/src/components/ResourceNameFilter.jsx');
    const html = renderToStaticMarkup(React.createElement(ResourceNameFilter, {
      value: 'new', onChange() {}, resources: [{ name: 'APP-NEW', id: 'SECRET-UUID' }],
      label: 'Name', placeholder: 'Search name', clearLabel: 'Clear name filter', emptyText: 'No matching results.',
    }));
    assert.match(html, /role="combobox"/);
    assert.match(html, /aria-autocomplete="list"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /SECRET-UUID/);
  } finally { await vite.close(); }
});
