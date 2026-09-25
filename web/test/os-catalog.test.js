import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { catalogGroups, distroKey, distroLabel, OTHER_DISTRO } from '../src/osCatalog.js';

const images = [
  { id: 'u22', name: 'Ubuntu 22.04 LTS', status: 'active', os_distro: 'ubuntu', os_version: '22.04', architecture: 'x86_64' },
  { id: 'u24', name: 'Ubuntu 24.04 LTS', status: 'active', os_distro: ' UBUNTU ', os_version: '24.04' },
  { id: 'u18', name: 'Ubuntu 18.04', status: 'active', os_distro: 'Ubuntu', os_version: '18.04' },
  { id: 'win', name: 'Windows Server 2022', status: 'active', os_distro: 'windows', os_version: '2022' },
  { id: 'deb', name: 'Debian 12', status: 'active', os_distro: 'debian' },
  { id: 'rocky', name: 'Rocky Linux 9', status: 'active', os_distro: 'rocky', os_version: '9' },
  { id: 'oracle', name: 'Oracle Linux 9', status: 'active', os_distro: 'oraclelinux' },
  { id: 'appliance', name: 'Custom firewall', status: 'active' },
  { id: 'queued', name: 'Not ready', status: 'queued', os_distro: 'ubuntu' },
];

test('catalog groups dynamic distros, normalizes case, sorts versions, and retains Other', () => {
  const groups = catalogGroups(images);
  assert.deepEqual(groups.map((group) => group.key), ['ubuntu', 'windows', 'debian', 'rocky', 'oraclelinux', OTHER_DISTRO]);
  assert.deepEqual(groups[0].images.map((image) => image.id), ['u24', 'u22', 'u18']);
  assert.equal(groups.find((group) => group.key === OTHER_DISTRO).images[0].id, 'appliance');
  assert.equal(distroKey(images[1]), 'ubuntu');
  assert.equal(distroLabel('oraclelinux', 'Other'), 'Oraclelinux');
  assert.equal(images[1].os_distro, ' UBUNTU ');
});

test('search matches image, distro, and metadata version without changing the permitted list', () => {
  assert.deepEqual(catalogGroups(images, '24.04').flatMap((group) => group.images.map((image) => image.id)), ['u24']);
  assert.deepEqual(catalogGroups(images, 'windows').flatMap((group) => group.images.map((image) => image.id)), ['win']);
  assert.deepEqual(catalogGroups(images, 'firewall').flatMap((group) => group.images.map((image) => image.id)), ['appliance']);
  assert.deepEqual(catalogGroups(images, 'Khác', 'Khác').flatMap((group) => group.images.map((image) => image.id)), ['appliance']);
  assert.equal(images.length, 9);
});

test('OS catalog renders metadata, selected image, and vi/en labels without translating image names', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { default: OsCatalog } = await vite.ssrLoadModule('/src/components/OsCatalog.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const render = (locale) => {
      globalThis.localStorage = { getItem: (key) => key === 'cmp.locale' ? locale : null };
      return renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(OsCatalog, { images, selectedImageId: 'u22', onSelect: () => {} })));
    };
    const en = render('en');
    assert.match(en, /Operating System/);
    assert.match(en, /Available Images/);
    assert.match(en, /Ubuntu 22.04 LTS/);
    assert.match(en, /Oraclelinux/);
    assert.match(en, /Other/);
    assert.match(en, /Selected Image/);
    assert.doesNotMatch(en, /Not ready/);
    const vi = render('vi');
    assert.match(vi, /Hệ điều hành/);
    assert.match(vi, /Image đã chọn/);
    assert.match(vi, /Ubuntu 22.04 LTS/);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});
