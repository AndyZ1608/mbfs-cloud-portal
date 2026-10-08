import { randomUUID } from 'node:crypto';
import { classificationDb, transaction } from './classificationDb.js';

const key = (identity) => [identity.provider, identity.issuer, identity.subject];

export function findBySsoIdentity(identity, db = classificationDb()) {
  return db.prepare('SELECT * FROM sso_identity_bindings WHERE provider = ? AND issuer = ? AND subject = ?').get(...key(identity)) || null;
}

export function findByKeystoneUserId(userId, db = classificationDb()) {
  return db.prepare('SELECT * FROM sso_identity_bindings WHERE keystone_user_id = ?').get(userId) || null;
}

export function createBinding(identity, userId, db = classificationDb()) {
  const now = new Date().toISOString();
  return transaction(db, () => {
    if (findBySsoIdentity(identity, db) || findByKeystoneUserId(userId, db)) return null;
    const binding = { id: randomUUID(), provider: identity.provider, issuer: identity.issuer,
      subject: identity.subject, keystone_user_id: userId, sso_username: identity.username || null,
      sso_email: identity.email || null, created_at: now, updated_at: now };
    const inserted = db.prepare(`INSERT OR IGNORE INTO sso_identity_bindings
      (id, provider, issuer, subject, keystone_user_id, sso_username, sso_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(binding));
    return inserted.changes === 1 ? binding : null;
  });
}

export function updateProfileSnapshot(identity, db = classificationDb()) {
  db.prepare(`UPDATE sso_identity_bindings SET sso_username = ?, sso_email = ?, updated_at = ?
    WHERE provider = ? AND issuer = ? AND subject = ?`).run(
    identity.username || null, identity.email || null, new Date().toISOString(), ...key(identity));
}

export function claimOnboarding(identity, db = classificationDb()) {
  const attempt = randomUUID();
  const inserted = db.prepare(`INSERT OR IGNORE INTO sso_onboarding_claims(provider, issuer, subject, attempt_id, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(...key(identity), attempt, new Date().toISOString());
  return inserted.changes === 1 ? attempt : null;
}

export function releaseOnboarding(identity, attempt, db = classificationDb()) {
  db.prepare(`DELETE FROM sso_onboarding_claims WHERE provider = ? AND issuer = ? AND subject = ?
    AND attempt_id = ?`).run(...key(identity), attempt);
}
