import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { createServer } from 'vite';
import { canChangeAccountPassword, emptyAccountPasswordForm, submitAccountPassword, validateAccountPasswordForm } from '../src/accountPassword.js';
import { translate } from '../src/i18n/index.js';
import { api } from '../src/api.js';

test('account password validation blocks empty, mismatched, and unchanged passwords before API calls', async () => {
  const sent = [];
  const send = async (...args) => { sent.push(args); return { success: true }; };
  const currentPassword = 'current-secret';
  for (const [form, key] of [
    [emptyAccountPasswordForm(), 'account.passwordRequired'],
    [{ currentPassword, newPassword: 'next', confirmPassword: 'other' }, 'account.passwordMismatch'],
    [{ currentPassword, newPassword: currentPassword, confirmPassword: currentPassword }, 'account.passwordSame'],
  ]) {
    assert.equal(validateAccountPasswordForm(form), key);
    assert.deepEqual(await submitAccountPassword(form, send), { validation: key });
  }
  assert.equal(sent.length, 0);
  const valid = { currentPassword, newPassword: 'next-secret', confirmPassword: 'next-secret' };
  assert.deepEqual(await submitAccountPassword(valid, send), { success: true });
  assert.deepEqual(sent, [['/account/change-password', { method: 'POST', body: {
    current_password: currentPassword, new_password: 'next-secret',
  } }]]);
});

test('account form renders exactly three password inputs with Vietnamese and English labels', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const previousStorage = globalThis.localStorage;
  try {
    const { default: AccountPasswordModal } = await vite.ssrLoadModule('/src/components/AccountPasswordModal.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    for (const [locale, labels] of [
      ['vi', ['Mật khẩu hiện tại', 'Mật khẩu mới', 'Xác nhận mật khẩu mới']],
      ['en', ['Current Password', 'New Password', 'Confirm New Password']],
    ]) {
      globalThis.localStorage = { getItem: (key) => key === 'cmp.locale' ? locale : null };
      const markup = renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(AccountPasswordModal, { username: 'alice', onClose: () => {}, onSuccess: () => {} })));
      assert.equal((markup.match(/type="password"/g) || []).length, 3);
      for (const label of labels) assert.ok(markup.includes(label), label);
      assert.ok(markup.includes('alice'));
      assert.doesNotMatch(markup, /User ID|Project ID|Keystone token/);
    }
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    await vite.close();
  }
});

test('login screen shows the localized sign-in-again notice after password change', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const previousStorage = globalThis.localStorage;
  try {
    const { default: Login } = await vite.ssrLoadModule('/src/pages/Login.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    for (const locale of ['vi', 'en']) {
      globalThis.localStorage = { getItem: (key) => key === 'cmp.locale' ? locale : null };
      const markup = renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(StaticRouter, { location: { pathname: '/login', state: { notice: 'passwordChanged' } } },
          React.createElement(Login))));
      assert.ok(markup.includes(translate(locale, 'account.passwordChangeSuccess')));
      assert.ok(markup.includes(translate(locale, 'account.signInAgain')));
    }
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    await vite.close();
  }
});

test('localized errors, success notice, Account menu, and wrong-password 401 behavior remain wired', () => {
  assert.equal(canChangeAccountPassword({ auth_mode: 'keystone' }), true);
  assert.equal(canChangeAccountPassword({ auth_mode: 'sso' }), false);
  assert.equal(canChangeAccountPassword({ auth_mode: 'websso' }), false);
  for (const locale of ['vi', 'en']) {
    for (const key of ['account.passwordMismatch', 'account.passwordSame', 'account.currentPasswordIncorrect',
      'account.passwordRejected', 'account.passwordUnsupported', 'account.passwordChangeSuccess', 'account.signInAgain']) {
      assert.notEqual(translate(locale, key), key);
    }
  }
  const source = (file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
  assert.match(source('../src/components/Layout.jsx'), /<AccountMenu/);
  assert.match(source('../src/components/Layout.jsx'), /canChangeAccountPassword/);
  assert.match(source('../src/pages/Login.jsx'), /passwordChanged/);
  assert.match(source('../src/api.js'), /data\?\.code !== 'account_current_password_incorrect'/);
  assert.doesNotMatch(source('../src/components/AccountPasswordModal.jsx'), /localStorage|sessionStorage|console\.log/);
});

test('wrong current password keeps the account form on the current session instead of redirecting', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { location: { href: '/instances' } };
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'account_current_password_incorrect', error: 'sanitized' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  });
  try {
    await assert.rejects(api('/account/change-password', { method: 'POST', body: {
      current_password: 'wrong', new_password: 'new',
    } }), { code: 'account_current_password_incorrect' });
    assert.equal(globalThis.window.location.href, '/instances');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
