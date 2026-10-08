import { OSError, MOCK, passwordAuth, providerFetch } from './openstack.js';
import { mockFetch } from './mock.js';

const authUrl = String(process.env.OS_AUTH_URL || 'http://127.0.0.1:5000/v3').replace(/\/+$/, '').replace(/\/v3$/, '') + '/v3';
const service = {
  username: process.env.SSO_KEYSTONE_USERNAME || '',
  password: process.env.SSO_KEYSTONE_PASSWORD || '',
  domain: process.env.SSO_KEYSTONE_DOMAIN || process.env.OS_DEFAULT_DOMAIN || 'Default',
};
export const provisioningEnabled = process.env.SSO_PROVISIONING_ENABLED === 'true';
export const accountServiceConfigured = () => MOCK || !!(service.username && service.password);

async function serviceToken() {
  if (MOCK) return 'mock-sso-identity-service';
  if (!accountServiceConfigured()) throw new OSError(503, 'SSO account service is not configured', 'sso_account_service_unavailable');
  const response = await providerFetch(`${authUrl}/auth/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ auth: { identity: { methods: ['password'], password: {
      user: { name: service.username, domain: { name: service.domain }, password: service.password },
    } }, scope: { system: { all: true } } } }),
  });
  if (!response.ok) throw new OSError(503, 'SSO account service is unavailable', 'sso_account_service_unavailable');
  const token = response.headers.get('x-subject-token');
  if (!token) throw new OSError(503, 'SSO account service is unavailable', 'sso_account_service_unavailable');
  return token;
}

async function identityRequest(method, path, body) {
  if (MOCK) return mockFetch('identity', method, `/v3${path}`, body);
  const token = await serviceToken();
  const response = await providerFetch(`${authUrl}${path}`, {
    method, headers: { 'X-Auth-Token': token, Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 404 && ((method === 'GET' && /^\/users\/[^/?]+$/.test(path)) ||
    (method === 'DELETE' && /^\/users\/[^/?]+$/.test(path)))) return null;
  if (response.status === 409 && method === 'POST' && path === '/users') {
    throw new OSError(409, 'Cloud username already exists', 'sso_username_collision');
  }
  if (!response.ok) throw new OSError(503, 'Keystone account operation is unavailable', 'sso_account_service_unavailable');
  if (response.status === 204) return null;
  return response.json();
}

export async function getKeystoneUserById(id) {
  try { return (await identityRequest('GET', `/users/${encodeURIComponent(id)}`))?.user || null; }
  catch (error) { if (MOCK && error?.status === 404) return null; throw error; }
}

export async function proveKeystoneOwnership(username, password, domain) {
  try {
    const result = await passwordAuth(username, password, domain);
    if (!result?.user?.id) throw new Error('Missing Keystone user');
    return result.user.id; // The proof token is intentionally discarded.
  } catch { throw new OSError(401, 'Unable to verify the Cloud account', 'sso_ownership_failed'); }
}

async function targetDomain() {
  if (MOCK) return { id: 'default', name: service.domain };
  const result = await identityRequest('GET', `/domains?name=${encodeURIComponent(service.domain)}`);
  const domain = result?.domains?.find((item) => item.name === service.domain);
  if (!domain?.id) throw new OSError(503, 'Keystone domain is unavailable', 'sso_account_service_unavailable');
  return domain;
}

export async function createKeystoneUser(username, email) {
  if (!provisioningEnabled) throw new OSError(403, 'Cloud account creation is disabled', 'sso_provision_disabled');
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(username || '')) {
    throw new OSError(400, 'SSO username cannot be used as a Cloud username', 'sso_username_invalid');
  }
  const domain = await targetDomain();
  const existing = await identityRequest('GET', `/users?name=${encodeURIComponent(username)}&domain_id=${encodeURIComponent(domain.id)}`);
  if (!Array.isArray(existing?.users)) throw new OSError(503, 'Keystone user lookup is unavailable', 'sso_account_service_unavailable');
  if (existing?.users?.some((item) => item.name === username && (!item.domain_id || item.domain_id === domain.id))) {
    throw new OSError(409, 'Cloud username already exists', 'sso_username_collision');
  }
  let result;
  try {
    result = await identityRequest('POST', '/users', { user: {
      name: username, domain_id: domain.id, enabled: true,
      ...(email ? { email } : {}),
      // Deliberately no password, default project, or role assignment.
    } });
  } catch (error) {
    // A lost response may mean Keystone created the user. Never retry blindly.
    if (error.code !== 'sso_username_collision') error.provisioningOutcomeUnknown = true;
    throw error;
  }
  if (!result?.user?.id || result.user.name !== username ||
    (result.user.domain_id && result.user.domain_id !== domain.id)) {
    const error = new OSError(503, 'Keystone user creation result is incomplete', 'sso_account_service_unavailable');
    error.provisioningOutcomeUnknown = true;
    throw error;
  }
  return result.user;
}

export async function deleteNewKeystoneUser(id) {
  await identityRequest('DELETE', `/users/${encodeURIComponent(id)}`);
}
