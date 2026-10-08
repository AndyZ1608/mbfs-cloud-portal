import test from 'node:test';
import assert from 'node:assert/strict';
import { openClassificationDb } from '../classificationDb.js';
import { findBySsoIdentity, findByKeystoneUserId, createBinding, updateProfileSnapshot,
  claimOnboarding, releaseOnboarding } from '../ssoBindings.js';
import { requireAuth } from '../middleware.js';

test('SSO bindings use issuer and subject, never mutable email or username', () => {
  const db = openClassificationDb(':memory:');
  const first = { provider: 'keycloak', issuer: 'https://idp/realm-a', subject: '123',
    username: 'old-name', email: 'old@example.com' };
  const binding = createBinding(first, 'keystone-user-1', db);
  assert.equal(binding.keystone_user_id, 'keystone-user-1');
  const changed = { ...first, username: 'new-name', email: 'new@example.com' };
  assert.equal(findBySsoIdentity(changed, db).keystone_user_id, 'keystone-user-1');
  updateProfileSnapshot(changed, db);
  assert.equal(findBySsoIdentity(first, db).sso_email, 'new@example.com');
  assert.equal(findBySsoIdentity({ ...first, subject: '456', email: 'new@example.com' }, db), null);
  assert.equal(findBySsoIdentity({ ...first, issuer: 'https://idp/realm-b' }, db), null);
  assert.equal(findByKeystoneUserId('keystone-user-1', db).subject, '123');
  assert.equal(createBinding({ ...first, subject: '456' }, 'keystone-user-1', db), null);
  assert.equal(createBinding(first, 'keystone-user-2', db), null);
  db.close();
});

test('onboarding claim serializes duplicate provisioning attempts', () => {
  const db = openClassificationDb(':memory:');
  const identity = { provider: 'keycloak', issuer: 'https://idp/realm-a', subject: 'new' };
  const first = claimOnboarding(identity, db);
  assert.ok(first);
  assert.equal(claimOnboarding(identity, db), null);
  releaseOnboarding(identity, 'wrong-attempt', db);
  assert.equal(claimOnboarding(identity, db), null);
  releaseOnboarding(identity, first, db);
  assert.ok(claimOnboarding(identity, db));
  db.close();
});

test('legacy service-backed SSO sessions cannot call protected resource APIs', () => {
  for (const os of [
    { auth_mode: 'sso', token_source: 'service', token: 'old-service-token' },
    { token_source: 'service', token: 'old-service-token' },
  ]) {
    let outcome;
    requireAuth({ session: { os } }, {}, (error) => { outcome = error; });
    assert.equal(outcome?.status, 401);
  }
  let outcome = 'not-called';
  requireAuth({ session: { os: { token_source: 'user', token: 'user-token' } } }, {}, (error) => { outcome = error; });
  assert.equal(outcome, undefined);
});
