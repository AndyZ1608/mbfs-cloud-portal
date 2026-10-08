import { Router } from 'express';
import { createHash } from 'node:crypto';
import { OSError } from '../openstack.js';
import { SSO, ssoConfigError, beginOidcLogin, completeOidcLogin } from '../oidc.js';
import { findBySsoIdentity, findByKeystoneUserId, createBinding,
  updateProfileSnapshot, claimOnboarding, releaseOnboarding } from '../ssoBindings.js';
import { accountServiceConfigured, provisioningEnabled, getKeystoneUserById,
  proveKeystoneOwnership, createKeystoneUser, deleteNewKeystoneUser } from '../keystoneSsoAccounts.js';
import { destroyCmpSession } from './auth.js';
import { record } from '../audit.js';

const router = Router();
const enabled = () => SSO.enabled && !ssoConfigError() && accountServiceConfigured();
const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
const subjectHash = (identity) => createHash('sha256').update(`${identity.issuer}|${identity.subject}`).digest('hex').slice(0, 16);
const audit = (req, action, identity, result, userId = null) => record({
  action, result, provider: 'keycloak', source: 'cmp', request_id: req.id,
  subject_hash: identity ? subjectHash(identity) : null,
  keystone_user_id: userId, user: null, project: null,
});

function safeSession(sso) {
  return {
    auth_mode: 'sso', auth_state: sso.state, ssoVerified: true,
    bindingStatus: sso.state === 'SSO_VERIFIED_UNBOUND' ? 'unbound'
      : sso.state === 'SSO_VERIFIED_BOUND' ? 'bound'
        : sso.state === 'SSO_BOUND_USER_MISSING' ? 'missing' : 'disabled',
    profile: { displayName: sso.identity.displayName, username: sso.identity.username,
      email: sso.identity.email, emailVerified: sso.identity.emailVerified },
    ...(sso.cloudUser ? { cloudUser: { name: sso.cloudUser.name, enabled: sso.cloudUser.enabled } } : {}),
    provisioningEnabled,
  };
}
export { safeSession };

async function boundState(identity) {
  const binding = findBySsoIdentity(identity);
  if (!binding) return { state: 'SSO_VERIFIED_UNBOUND', identity };
  updateProfileSnapshot(identity);
  const user = await getKeystoneUserById(binding.keystone_user_id);
  if (!user) return { state: 'SSO_BOUND_USER_MISSING', identity };
  if (user.enabled === false) return { state: 'SSO_BOUND_USER_DISABLED', identity,
    cloudUser: { name: user.name, enabled: false } };
  return { state: 'SSO_VERIFIED_BOUND', identity,
    cloudUser: { name: user.name, enabled: true } };
}

router.get('/auth/sso/config', (_req, res) => res.json({
  enabled: enabled(), label: SSO.buttonLabel, allowLocal: true,
  provisioningEnabled,
  error: SSO.enabled ? ssoConfigError() || (!accountServiceConfigured() ? 'Missing SSO_KEYSTONE_USERNAME, SSO_KEYSTONE_PASSWORD' : null) : null,
}));

router.get('/auth/sso/login', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (!enabled()) return res.redirect('/login?sso_error=unavailable');
    await regenerate(req);
    const { url, transaction } = await beginOidcLogin();
    req.session.oidcTransaction = transaction;
    res.redirect(url);
  } catch {
    audit(req, 'auth.sso.login.failed', null, 'failure');
    res.redirect('/login?sso_error=unavailable');
  }
});

router.get('/auth/sso/callback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let identity;
  try {
    if (!enabled()) throw new Error('SSO unavailable');
    const transaction = req.session.oidcTransaction;
    delete req.session.oidcTransaction; // one-time even for invalid responses
    if (!transaction || typeof req.query.code !== 'string' || typeof req.query.state !== 'string' || req.query.error) {
      throw new Error('Invalid authorization response');
    }
    identity = await completeOidcLogin(new URL(req.originalUrl, 'http://localhost').search, transaction);
    const sso = await boundState(identity);
    await regenerate(req); // rotate anonymous pre-auth session ID
    req.session.sso = sso; // no Keycloak or Keystone tokens retained
    audit(req, 'auth.sso.login.success', identity, 'success', findBySsoIdentity(identity)?.keystone_user_id);
    if (sso.state === 'SSO_BOUND_USER_MISSING' || sso.state === 'SSO_BOUND_USER_DISABLED') {
      audit(req, 'auth.sso.bound_user.invalid', identity, 'failure');
    }
    res.redirect('/sso/onboarding');
  } catch {
    audit(req, 'auth.sso.login.failed', identity, 'failure');
    res.redirect('/login?sso_error=failed');
  }
});

function requireUnbound(req, _res, next) {
  if (!req.session.sso?.identity) return next(new OSError(401, 'SSO sign-in required', 'authentication_required'));
  if (req.session.sso.state !== 'SSO_VERIFIED_UNBOUND') {
    return next(new OSError(409, 'SSO identity is not awaiting onboarding', 'sso_not_unbound'));
  }
  next();
}

router.post('/auth/sso/link-existing', requireUnbound, async (req, res, next) => {
  const identity = req.session.sso.identity;
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some((field) => !['username', 'password', 'domain'].includes(field))) {
      throw new OSError(400, 'Invalid onboarding input', 'sso_invalid_input');
    }
    const { username, password, domain } = req.body || {};
    if (typeof username !== 'string' || !username.trim() || username.length > 128 ||
      typeof password !== 'string' || !password || password.length > 1024 ||
      (domain !== undefined && (typeof domain !== 'string' || domain.length > 128))) {
      throw new OSError(400, 'Cloud username and password are required', 'sso_ownership_failed');
    }
    const userId = await proveKeystoneOwnership(username.trim(), password,
      typeof domain === 'string' && domain.trim() ? domain.trim() : process.env.OS_DEFAULT_DOMAIN || 'Default');
    const existing = findBySsoIdentity(identity);
    if (existing) throw new OSError(409, 'SSO identity is already linked', 'sso_already_bound');
    if (findByKeystoneUserId(userId)) throw new OSError(409, 'Cloud account is already linked', 'sso_binding_collision');
    const user = await getKeystoneUserById(userId);
    if (!user) throw new OSError(404, 'Cloud account no longer exists', 'sso_bound_user_missing');
    if (user.enabled === false) throw new OSError(403, 'Cloud account is disabled', 'sso_bound_user_disabled');
    if (!createBinding(identity, userId)) throw new OSError(409, 'Cloud account is already linked', 'sso_binding_collision');
    req.session.sso = { state: 'SSO_VERIFIED_BOUND', identity, cloudUser: { name: user.name, enabled: true } };
    audit(req, 'identity.sso.binding.linked', identity, 'success', userId);
    res.json(safeSession(req.session.sso));
  } catch (error) {
    audit(req, 'identity.sso.binding.linked', identity, 'failure');
    next(error);
  }
});

router.post('/auth/sso/create-cloud-account', requireUnbound, async (req, res, next) => {
  const identity = req.session.sso.identity;
  if (!provisioningEnabled) return next(new OSError(403, 'Cloud account creation is disabled', 'sso_provision_disabled'));
  let attempt;
  let createdUser = null;
  let releaseClaim = true;
  try {
    if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
      throw new OSError(400, 'Invalid onboarding input', 'sso_invalid_input');
    }
    attempt = claimOnboarding(identity);
    if (!attempt) throw new OSError(409, 'Cloud account creation is already in progress', 'sso_onboarding_in_progress');
    if (findBySsoIdentity(identity)) throw new OSError(409, 'SSO identity is already linked', 'sso_already_bound');
    createdUser = await createKeystoneUser(identity.username, identity.emailVerified ? identity.email : null);
    if (!createBinding(identity, createdUser.id)) throw new OSError(409, 'SSO identity is already linked', 'sso_binding_collision');
    req.session.sso = { state: 'SSO_VERIFIED_BOUND', identity,
      cloudUser: { name: createdUser.name, enabled: true } };
    audit(req, 'identity.sso.provision.created', identity, 'success', createdUser.id);
    res.json(safeSession(req.session.sso));
  } catch (error) {
    if (error.provisioningOutcomeUnknown) {
      releaseClaim = false;
      console.error(`[sso] provisioning outcome unknown request_id=${req.id}; operator reconciliation required`);
    }
    if (createdUser) {
      try {
        // Never delete a newly created user if the DB cannot establish whether
        // it became bound. Retain the claim for operator reconciliation.
        if (!findByKeystoneUserId(createdUser.id)) await deleteNewKeystoneUser(createdUser.id);
      } catch {
        releaseClaim = false;
        console.error(`[sso] provisioning cleanup uncertain request_id=${req.id} keystone_user_id=${createdUser.id}`);
      }
    }
    audit(req, 'identity.sso.provision.created', identity, 'failure', createdUser?.id);
    next(error);
  } finally {
    if (attempt && releaseClaim) {
      try { releaseOnboarding(identity, attempt); }
      catch { console.error(`[sso] onboarding claim release failed request_id=${req.id}`); }
    }
  }
});

router.post('/auth/sso/logout', async (req, res, next) => {
  try {
    if (req.session.sso?.identity) audit(req, 'auth.sso.logout', req.session.sso.identity, 'success');
    await destroyCmpSession(req, res);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

export default router;
