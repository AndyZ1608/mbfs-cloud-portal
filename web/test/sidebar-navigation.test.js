import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translate } from '../src/i18n/index.js';

const storage = (locale) => ({ getItem: (key) => key === 'cmp.locale' ? locale : null });

test('navigation maps only existing routes, with Dashboard and feature-gated Billing standalone', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { NAVIGATION, visibleNavigation } = await vite.ssrLoadModule('/src/components/SidebarNavigation.jsx');
    assert.equal(NAVIGATION[0].to, '/');
    assert.ok(!NAVIGATION[0].children);
    assert.deepEqual(NAVIGATION.filter((entry) => entry.children).map((group) => group.key), ['compute', 'storage', 'network', 'platform', 'operations']);
    assert.equal(NAVIGATION[4].to, '/billing');
    assert.ok(!NAVIGATION[4].children);
    assert.deepEqual(NAVIGATION[5].children.map((item) => item.to), ['/kubernetes', '/marketplace']);
    const all = NAVIGATION.flatMap((entry) => entry.children || [entry]).map((item) => item.to);
    assert.equal(new Set(all).size, all.length);
    const appSource = readFileSync(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
    const routedPages = [...appSource.matchAll(/<Route path="(\/[^\"]+)" element={<(?!Navigate)(\w+)/g)]
      .map((match) => match[1]).filter((path) => path !== '/login' && !path.includes('/:'));
    assert.deepEqual(all.slice().sort(), ['/', ...routedPages].sort());
    for (const nonRoute of ['/flavors', '/snapshots', '/routers', '/monitoring']) assert.ok(!all.includes(nonRoute));
    const member = visibleNavigation({ config: { billingEnabled: false }, roles: ['member'] });
    assert.ok(!member.flatMap((entry) => entry.children || [entry]).some((item) => ['/billing', '/admin'].includes(item.to)));
    assert.ok(member.some((entry) => entry.key === 'platform'));
    const admin = visibleNavigation({ config: { billingEnabled: true }, roles: ['member', 'admin'] });
    assert.ok(admin.flatMap((entry) => entry.children || [entry]).some((item) => item.to === '/admin'));
    assert.ok(admin.some((entry) => entry.to === '/billing' && !entry.children));
    const empty = visibleNavigation({
      config: { billingEnabled: false }, roles: ['member'],
      navigation: [{ key: 'platform', children: [{ to: '/billing', feature: 'billing' }] }],
    });
    assert.deepEqual(empty, []);
  } finally { await vite.close(); }
});

test('route state expands the matching group, including deep links and browser-history targets', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { activeGroupForPath, routeMatchesItem, toggleOpenGroup } = await vite.ssrLoadModule('/src/components/SidebarNavigation.jsx');
    assert.equal(activeGroupForPath('/'), null);
    assert.equal(activeGroupForPath('/networks'), 'network');
    assert.equal(activeGroupForPath('/networks/net-1'), 'network');
    assert.equal(activeGroupForPath('/instances/vm-1'), 'compute');
    assert.equal(activeGroupForPath('/billing'), null);
    assert.equal(activeGroupForPath('/billing/instances/vm-1'), null);
    assert.equal(activeGroupForPath('/volumes/vol-1'), 'storage');
    assert.equal(routeMatchesItem('/instances-extra', { to: '/instances' }), false);
    assert.equal(toggleOpenGroup('compute', 'storage'), 'storage');
    assert.equal(toggleOpenGroup('storage', 'storage'), null);
  } finally { await vite.close(); }
});

test('rendered sidebar uses accessible accordion controls and active child links', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { default: SidebarNavigation } = await vite.ssrLoadModule('/src/components/SidebarNavigation.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const render = (path, locale, billingEnabled = true) => {
      globalThis.localStorage = storage(locale);
      return renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(StaticRouter, { location: path },
          React.createElement(SidebarNavigation, { config: { billingEnabled }, roles: ['member'] }))));
    };
    const network = render('/networks', 'en');
    assert.match(network, /aria-label="Dashboard"/);
    const billingLink = (markup) => markup.match(/<a[^>]*href="\/billing"[^>]*>/)?.[0] || '';
    assert.match(billingLink(network), /aria-label="Billing"/);
    assert.match(billingLink(network), /class="nav-item nav-standalone"/);
    assert.match(network, /aria-label="Network" aria-expanded="true"/);
    assert.match(network, /aria-label="Compute" aria-expanded="false"/);
    assert.match(network, /aria-current="page"[^>]*href="\/networks"/);
    assert.equal((network.match(/aria-expanded="true"/g) || []).length, 1);
    assert.match(network, /id="nav-group-compute"[^>]*hidden=""/);
    const deep = render('/instances/vm-1', 'en');
    assert.match(deep, /aria-label="Compute" aria-expanded="true"/);
    assert.match(deep, /aria-current="page"[^>]*href="\/instances"/);
    for (const path of ['/billing', '/billing/instances/vm-1']) {
      const billing = render(path, 'en');
      assert.match(billingLink(billing), /class="nav-item nav-standalone active"/);
      assert.match(billingLink(billing), /aria-current="page"/);
      assert.equal((billing.match(/aria-expanded="true"/g) || []).length, 0);
    }
    const vi = render('/networks', 'vi');
    assert.match(vi, /Nền tảng \/ Dịch vụ/);
    assert.match(vi, /Vận hành/);
    assert.match(vi, /aria-label="Network" aria-expanded="true"/);
    assert.equal(translate('en', 'navigation.platform'), 'Platform / Services');
    assert.equal(translate('vi', 'navigation.platform'), 'Nền tảng / Dịch vụ');
    const noBilling = render('/networks', 'en', false);
    assert.doesNotMatch(noBilling, /href="\/billing"/);
    assert.doesNotMatch(noBilling, /href="\/admin"/);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});
