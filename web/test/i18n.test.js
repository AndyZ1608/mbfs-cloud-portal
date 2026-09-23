import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyLocale, initialLocale, intlLocale, LOCALE_STORAGE_KEY, normalizeLocale, resources, setRuntimeLocale, translate } from '../src/i18n/index.js';
import { apiErrorMessage } from '../src/api.js';
import { formatVnd } from '../src/utils/billing.js';
import { createRfbSession } from '../src/console/rfbSession.js';
import { noticeDetail, noticeTitle } from '../src/i18n/notifications.js';

function storage(value) {
  return { getItem: (key) => key === LOCALE_STORAGE_KEY ? value : null };
}

test('Vietnamese is default; saved English persists; invalid saved values fall back', () => {
  assert.equal(initialLocale(storage(null)), 'vi');
  assert.equal(initialLocale(storage('en')), 'en');
  assert.equal(initialLocale(storage('xx')), 'vi');
  assert.equal(initialLocale({ getItem: () => { throw new Error('storage blocked'); } }), 'vi');
  assert.equal(normalizeLocale('EN'), 'vi');
});

test('language changes update HTML lang and the saved browser preference', () => {
  const saved = new Map();
  const root = { lang: 'vi', setAttribute(name, value) { if (name === 'lang') this.lang = value; } };
  const environment = { document: { documentElement: root }, localStorage: {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  } };
  try {
    assert.equal(applyLocale('en', environment), 'en');
    assert.equal(root.lang, 'en');
    assert.equal(initialLocale(environment.localStorage), 'en');
    assert.equal(translate('en', 'navigation.instances'), 'Virtual Machines');
    assert.equal(applyLocale('vi', environment), 'vi');
    assert.equal(root.lang, 'vi');
    assert.equal(initialLocale(environment.localStorage), 'vi');
    assert.equal(translate('vi', 'navigation.instances'), 'Máy ảo');
  } finally { setRuntimeLocale('vi'); }
});

test('locale resources match and interpolation preserves resource identifiers', () => {
  assert.deepEqual(Object.keys(resources.vi).sort(), Object.keys(resources.en).sort());
  for (const key of Object.keys(resources.vi)) {
    assert.ok(resources.vi[key], `empty Vietnamese translation: ${key}`);
    assert.ok(resources.en[key], `empty English translation: ${key}`);
    const placeholders = (value) => [...value.matchAll(/{{\s*([\w.]+)\s*}}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(resources.en[key]), placeholders(resources.vi[key]), `interpolation mismatch: ${key}`);
  }
  const name = 'Ubuntu-Production';
  assert.match(translate('vi', 'instances.deleteSent', { name }), /Ubuntu-Production/);
  assert.match(translate('en', 'instances.deleteSent', { name }), /Ubuntu-Production/);
  assert.equal(translate('en', 'instances.resizeWaiting', { name }).includes('VERIFY_RESIZE'), true);
  assert.equal(translate('en', 'instances.confirmResize').includes('Confirm Resize'), true);
  assert.equal(translate('en', 'instances.revertResize'), 'Revert Resize');
  assert.equal(translate('en', 'backup.copies', { count: 1 }), '1 copy');
  assert.equal(translate('en', 'backup.copies', { count: 2 }), '2 copies');
  assert.equal(translate('vi', 'backup.copies', { count: 2 }), '2 bản');
  const unique = '__fallback_test__';
  resources.vi[unique] = 'Dự phòng';
  try { assert.equal(translate('en', unique), 'Dự phòng'); }
  finally { delete resources.vi[unique]; }
});

test('all static translation calls resolve in both languages', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.[jt]sx?$/.test(entry.name) && !path.includes(`${join(src, 'i18n', 'locales')}`)) {
        const source = readFileSync(path, 'utf8');
        for (const [, key] of source.matchAll(/\bt\(['"]([a-z][\w.-]+)['"]/g)) {
          assert.ok(resources.vi[key], `${path}: missing vi ${key}`);
          assert.ok(resources.en[key], `${path}: missing en ${key}`);
        }
      }
    }
  }
  visit(src);
});

test('VND stays VND and dates select the display locale', () => {
  try {
    setRuntimeLocale('vi');
    assert.equal(intlLocale(), 'vi-VN');
    assert.match(formatVnd('19266262.61015556'), /19\.266\.263\s*₫/);
    setRuntimeLocale('en');
    assert.equal(intlLocale(), 'en-US');
    assert.match(formatVnd('19266262.61015556'), /VND\s*19,266,263/);
  } finally { setRuntimeLocale('vi'); }
});

test('known backend codes localize; unknown provider diagnostics are not machine-translated', () => {
  try {
    setRuntimeLocale('en');
    assert.equal(apiErrorMessage({ code: 'invalid_instance_state', error: 'Không thể resize VM' }, 409), resources.en['errors.invalid_instance_state']);
    assert.match(apiErrorMessage({ error: 'No valid host was found' }, 502), /Provider message: No valid host was found/);
    assert.equal(apiErrorMessage({ error: 'Lỗi từ Nova' }, 502), resources.en['errors.requestFailed']);
  } finally { setRuntimeLocale('vi'); }
});

test('changing locale alone does not request or recreate an RFB session', async () => {
  let requests = 0;
  let creations = 0;
  let disconnects = 0;
  const session = createRfbSession({
    target: { replaceChildren() {} },
    requestConsole: async () => { requests += 1; return { url: 'wss://example.invalid' }; },
    parseConsoleUrl: (response) => response.url,
    createRfb: () => { creations += 1; return {
      addEventListener() {}, removeEventListener() {}, disconnect() { disconnects += 1; },
    }; },
    onState() {}, onRfb() {},
  });
  try {
    await session.connect();
    applyLocale('en', {});
    applyLocale('vi', {});
    assert.equal(requests, 1);
    assert.equal(creations, 1);
    assert.equal(disconnects, 0);
  } finally { session.dispose(); }
});

test('notification codes localize without changing names or legacy records', () => {
  const current = { code: 'highCpu', values: { name: 'Ubuntu-Production', cpu: 93, minutes: 6 } };
  assert.equal(noticeTitle(current, 'en'), 'High CPU: Ubuntu-Production');
  assert.equal(noticeDetail(current, 'en'), 'CPU 93% for 6 minutes');
  assert.equal(noticeTitle(current, 'vi'), 'CPU cao: Ubuntu-Production');
  const old = { title: 'CPU cao: Ubuntu-Production', detail: 'CPU cao liên tục' };
  assert.equal(noticeTitle(old, 'en'), 'Activity notification');
  assert.equal(noticeDetail(old, 'en'), '');
  assert.equal(noticeTitle(old, 'vi'), old.title);
});

test('critical pages render translated labels without touching VNC session props', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = storage('en');
  try {
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const { default: VncConsole } = await vite.ssrLoadModule('/src/components/VncConsole.jsx');
    const { default: Billing } = await vite.ssrLoadModule('/src/pages/Billing.jsx');
    const { default: Instances } = await vite.ssrLoadModule('/src/pages/Instances.jsx');
    const { default: TypeToConfirmDialog } = await vite.ssrLoadModule('/src/components/TypeToConfirmDialog.jsx');
    const { default: LanguageSwitcher } = await vite.ssrLoadModule('/src/components/LanguageSwitcher.jsx');
    const render = (element) => renderToStaticMarkup(React.createElement(LocaleProvider, null, element));
    const englishSwitcher = render(React.createElement(LanguageSwitcher));
    assert.match(englishSwitcher, /aria-label="Language"/);
    assert.match(englishSwitcher, /option value="en" selected=""/);
    const consoleHtml = render(React.createElement(VncConsole, { instanceId: 'vm-1', name: 'Ubuntu' }));
    assert.match(consoleHtml, /Console — Ubuntu/);
    assert.match(consoleHtml, /Reconnect/);
    assert.match(consoleHtml, /Clear/);
    assert.match(consoleHtml, /rows="3"/);
    assert.equal((consoleHtml.match(/class="vnc-screen"/g) || []).length, 1);
    assert.match(render(React.createElement(Billing)), /Loading Billing data/);
    assert.match(render(React.createElement(Instances)), /Virtual Machines/);
    const deleteHtml = render(React.createElement(TypeToConfirmDialog, {
      title: translate('en', 'instances.delete'), description: translate('en', 'instances.deleteDescription'),
      resourceName: 'Ubuntu-Production', resourceId: 'vm-1', confirmLabel: translate('en', 'instances.delete'),
      onConfirm: () => {}, onCancel: () => {},
    }));
    assert.match(deleteHtml, /Type Ubuntu-Production exactly to confirm/);
    assert.match(deleteHtml, /Delete VM/);
    globalThis.localStorage = storage('vi');
    const vietnameseSwitcher = render(React.createElement(LanguageSwitcher));
    assert.match(vietnameseSwitcher, /aria-label="Ngôn ngữ"/);
    assert.match(vietnameseSwitcher, /option value="vi" selected=""/);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    setRuntimeLocale('vi');
    await vite.close();
  }
});

test('all resource pages render their initial English UI', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = storage('en');
  try {
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    for (const page of ['Dashboard', 'Instances', 'Volumes', 'Networks', 'FloatingIPs', 'SecurityGroups',
      'Images', 'Keypairs', 'Billing', 'LoadBalancers', 'Backup', 'AuditLog', 'Optimize',
      'PowerSchedule', 'ObjectStorage', 'Marketplace', 'K8sClusters', 'Admin']) {
      const { default: Page } = await vite.ssrLoadModule(`/src/pages/${page}.jsx`);
      const markup = renderToStaticMarkup(React.createElement(LocaleProvider, null, React.createElement(Page)));
      assert.ok(markup.length > 0, `${page} rendered no markup`);
      assert.doesNotMatch(markup, />(?:Đang tải|Máy ảo|Tạo|Xoá|Không có)[^<]*</, `${page} retained Vietnamese UI text`);
    }
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    setRuntimeLocale('vi');
    await vite.close();
  }
});
