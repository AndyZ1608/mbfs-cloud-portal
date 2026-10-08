import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translate } from '../src/i18n/index.js';

const source = (name) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

test('SSO onboarding has a direct route outside the project-scoped layout', () => {
  const app = source('App.jsx');
  assert.match(app, /path="\/sso\/onboarding"/);
  assert.ok(app.indexOf('path="/sso/onboarding"') < app.indexOf('<Route element={<Layout />}>'));
  assert.match(source('useCmpSession.js'), /auth_mode === 'sso'.*navigate\('\/sso\/onboarding'/);
});

test('login keeps local Keystone and Keycloak choices even alongside existing WebSSO', () => {
  const login = source('pages/Login.jsx');
  assert.match(login, /\{cfg\.sso && \(/);
  assert.doesNotMatch(login, /\{cfg\.sso && !cfg\.websso/);
  assert.match(login, /href="\/api\/auth\/sso\/login"/);
  assert.match(login, /cfg\.allowLocal/);
});

test('onboarding has link, create, ready, missing and disabled states without browser token storage', () => {
  const page = source('pages/SsoOnboarding.jsx');
  for (const state of ['SSO_VERIFIED_UNBOUND', 'SSO_VERIFIED_BOUND', 'SSO_BOUND_USER_MISSING', 'SSO_BOUND_USER_DISABLED']) {
    assert.ok(page.includes(state));
  }
  assert.match(page, /auth\/sso\/link-existing/);
  assert.match(page, /auth\/sso\/create-cloud-account/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|id_token|access_token|refresh_token|subject/);
});

test('critical SSO onboarding labels are localized in Vietnamese and English', () => {
  for (const key of ['auth.ssoLogin', 'sso.unboundTitle', 'sso.linkExisting', 'sso.createAccount',
    'sso.cloudUsername', 'sso.currentPassword', 'sso.verifyLink', 'sso.readyTitle',
    'sso.disabledTitle', 'sso.missingTitle', 'sso.passwordOnce']) {
    for (const locale of ['vi', 'en']) assert.notEqual(translate(locale, key), key);
  }
});
