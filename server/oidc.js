import * as client from 'openid-client';
import { config } from './config.js';

const configuredIssuer = process.env.OIDC_ISSUER_URL || process.env.SSO_ISSUER || '';
const configuredClient = process.env.OIDC_CLIENT_ID || process.env.SSO_CLIENT_ID || '';
const configuredSecret = process.env.OIDC_CLIENT_SECRET || process.env.SSO_CLIENT_SECRET || '';
const configuredRedirect = process.env.OIDC_REDIRECT_URI ||
  (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/api/auth/sso/callback` : '');

export const SSO = Object.freeze({
  enabled: process.env.SSO_ENABLED === 'true',
  issuer: configuredIssuer.replace(/\/+$/, ''),
  clientId: configuredClient,
  clientSecret: configuredSecret,
  redirectUri: configuredRedirect,
  scopes: process.env.OIDC_SCOPES || process.env.SSO_SCOPES || 'openid profile email',
  buttonLabel: process.env.SSO_BUTTON_LABEL || 'Đăng nhập với SSO',
  allowLocal: process.env.SSO_ALLOW_LOCAL_LOGIN !== 'false',
});

export function ssoConfigError() {
  if (!SSO.enabled) return null;
  if (process.env.OS_INSECURE === 'true' || process.env.SSO_INSECURE === 'true') {
    return 'TLS verification must remain enabled for SSO';
  }
  const missing = [];
  if (!SSO.issuer) missing.push('OIDC_ISSUER_URL');
  if (!SSO.clientId) missing.push('OIDC_CLIENT_ID');
  if (!SSO.clientSecret) missing.push('OIDC_CLIENT_SECRET');
  if (!SSO.redirectUri) missing.push('OIDC_REDIRECT_URI');
  if (missing.length) return `Missing ${missing.join(', ')}`;
  try {
    const issuer = new URL(SSO.issuer);
    const redirect = new URL(SSO.redirectUri);
    if (issuer.search || issuer.hash || issuer.username || issuer.password ||
      redirect.search || redirect.hash || redirect.username || redirect.password ||
      redirect.pathname !== '/api/auth/sso/callback' ||
      (config.env === 'production' && (issuer.protocol !== 'https:' || redirect.protocol !== 'https:' || !config.secureCookies)) ||
      (issuer.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(issuer.hostname)) ||
      (redirect.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(redirect.hostname)) ||
      !['http:', 'https:'].includes(issuer.protocol) || !['http:', 'https:'].includes(redirect.protocol)) {
      return 'Invalid OIDC issuer or redirect URI';
    }
  } catch { return 'Invalid OIDC issuer or redirect URI'; }
  if (!SSO.scopes.split(/\s+/).includes('openid')) return 'OIDC_SCOPES must contain openid';
  return null;
}

let cached;
async function configuration() {
  if (ssoConfigError()) throw new Error('OIDC is not configured');
  if (cached && cached.until > Date.now()) return cached.value;
  const issuer = new URL(SSO.issuer);
  const value = await client.discovery(issuer, SSO.clientId, SSO.clientSecret, undefined,
    { timeout: Math.ceil(config.providerTimeoutMs / 1000),
      execute: issuer.protocol === 'http:'
        ? [client.allowInsecureRequests, client.enableNonRepudiationChecks]
        : [client.enableNonRepudiationChecks] });
  cached = { value, until: Date.now() + 10 * 60_000 };
  return value;
}

export async function beginOidcLogin() {
  const oidc = await configuration();
  const transaction = {
    state: client.randomState(), nonce: client.randomNonce(),
    verifier: client.randomPKCECodeVerifier(), at: Date.now(),
  };
  const challenge = await client.calculatePKCECodeChallenge(transaction.verifier);
  const url = client.buildAuthorizationUrl(oidc, {
    redirect_uri: SSO.redirectUri, response_type: 'code', scope: SSO.scopes,
    state: transaction.state, nonce: transaction.nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  return { url: url.href, transaction };
}

export async function completeOidcLogin(queryString, transaction) {
  if (!transaction || Date.now() - transaction.at > 10 * 60_000) throw new Error('OIDC transaction expired');
  const oidc = await configuration();
  const callback = new URL(SSO.redirectUri);
  callback.search = queryString;
  const tokens = await client.authorizationCodeGrant(oidc, callback, {
    expectedState: transaction.state, expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.verifier, idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || claims.iss !== SSO.issuer || typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('OIDC identity is incomplete');
  }
  return {
    provider: 'keycloak', issuer: claims.iss, subject: claims.sub,
    username: typeof claims.preferred_username === 'string' ? claims.preferred_username : null,
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === true,
    displayName: typeof claims.name === 'string' ? claims.name : null,
  };
}
