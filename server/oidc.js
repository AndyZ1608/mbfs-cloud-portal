// oidc.js — OIDC client tối giản cho Keycloak, KHÔNG dùng thư viện ngoài
// (build offline được). Hỗ trợ Authorization Code + PKCE, verify ID token RS256
// bằng JWKS của IdP.
import crypto from 'node:crypto';
import { config } from './config.js';

async function oidcFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.providerTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OIDC không phản hồi trong ${config.providerTimeoutMs}ms`);
    throw new Error('Không thể kết nối OIDC provider');
  } finally {
    clearTimeout(timer);
  }
}

export const SSO = {
  enabled: String(process.env.SSO_ENABLED || '').toLowerCase() === 'true',
  issuer: (process.env.SSO_ISSUER || '').replace(/\/+$/, ''),
  clientId: process.env.SSO_CLIENT_ID || '',
  clientSecret: process.env.SSO_CLIENT_SECRET || '',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  scopes: process.env.SSO_SCOPES || 'openid profile email',
  buttonLabel: process.env.SSO_BUTTON_LABEL || 'Đăng nhập bằng SSO (Keycloak)',
  groupClaim: process.env.SSO_GROUP_CLAIM || 'groups',
  projectPrefix: process.env.SSO_PROJECT_PREFIX ?? 'os-',
  adminGroup: process.env.SSO_ADMIN_GROUP || '',
  defaultProjects: (process.env.SSO_DEFAULT_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  allowLocal: String(process.env.SSO_ALLOW_LOCAL_LOGIN ?? 'true').toLowerCase() === 'true',
};
SSO.redirectUri = SSO.publicUrl ? `${SSO.publicUrl}/api/auth/sso/callback` : '';

if (String(process.env.SSO_INSECURE || '').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[sso] SSO_INSECURE=true — bỏ qua kiểm tra chứng chỉ TLS của Keycloak');
}

export function ssoConfigError() {
  if (!SSO.enabled) return null;
  const miss = [];
  if (!SSO.issuer) miss.push('SSO_ISSUER');
  if (!SSO.clientId) miss.push('SSO_CLIENT_ID');
  if (!SSO.publicUrl) miss.push('PUBLIC_URL');
  return miss.length ? `Thiếu cấu hình SSO: ${miss.join(', ')}` : null;
}

// ---------- Discovery + JWKS (cache 1h) ----------
let discoCache = null;
let jwksCache = { at: 0, keys: [] };

export async function discover() {
  if (discoCache && Date.now() - discoCache.at < 3600000) return discoCache.doc;
  const url = `${SSO.issuer}/.well-known/openid-configuration`;
  const res = await oidcFetch(url);
  if (!res.ok) throw new Error(`Không đọc được cấu hình OIDC tại ${url} (HTTP ${res.status})`);
  const doc = await res.json();
  discoCache = { at: Date.now(), doc };
  return doc;
}

async function getKey(kid) {
  const fresh = Date.now() - jwksCache.at < 3600000;
  if (fresh) {
    const hit = jwksCache.keys.find((k) => k.kid === kid);
    if (hit) return hit;
  }
  const doc = await discover();
  const res = await oidcFetch(doc.jwks_uri);
  if (!res.ok) throw new Error(`Không tải được JWKS (HTTP ${res.status})`);
  const { keys } = await res.json();
  jwksCache = { at: Date.now(), keys: keys || [] };
  const k = jwksCache.keys.find((x) => x.kid === kid);
  if (!k) throw new Error('ID token dùng khoá (kid) không có trong JWKS của Keycloak');
  return k;
}

// ---------- PKCE + state ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
export function newPkce() {
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, state: b64u(crypto.randomBytes(16)), nonce: b64u(crypto.randomBytes(16)) };
}

export async function authorizeUrl({ state, nonce, challenge }) {
  const doc = await discover();
  const q = new URLSearchParams({
    client_id: SSO.clientId,
    response_type: 'code',
    scope: SSO.scopes,
    redirect_uri: SSO.redirectUri,
    state, nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${doc.authorization_endpoint}?${q}`;
}

export async function exchangeCode(code, verifier) {
  const doc = await discover();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SSO.redirectUri,
    client_id: SSO.clientId,
    code_verifier: verifier,
  });
  if (SSO.clientSecret) body.set('client_secret', SSO.clientSecret);
  const res = await oidcFetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Keycloak từ chối đổi mã: ${data.error_description || data.error || res.status}`);
  return data; // { id_token, access_token, refresh_token, ... }
}

// ---------- Verify ID token ----------
export async function verifyIdToken(idToken, expectedNonce) {
  const [h, p, s] = String(idToken).split('.');
  if (!h || !p || !s) throw new Error('ID token không hợp lệ');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'RS256') throw new Error(`Thuật toán ${header.alg} không được hỗ trợ (cần RS256)`);

  const jwk = await getKey(header.kid);
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('Chữ ký ID token không hợp lệ');

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now - 60) throw new Error('ID token đã hết hạn');
  if (claims.iat && claims.iat > now + 300) throw new Error('ID token có thời gian phát hành bất thường');
  const iss = String(claims.iss || '').replace(/\/+$/, '');
  if (iss !== SSO.issuer) throw new Error(`Issuer không khớp (${iss})`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(SSO.clientId)) throw new Error('Audience không khớp client_id');
  if (expectedNonce && claims.nonce !== expectedNonce) throw new Error('Nonce không khớp (nghi ngờ replay)');
  return claims;
}

export async function logoutUrl(idToken) {
  try {
    const doc = await discover();
    if (!doc.end_session_endpoint) return null;
    const q = new URLSearchParams({ post_logout_redirect_uri: `${SSO.publicUrl}/login`, client_id: SSO.clientId });
    if (idToken) q.set('id_token_hint', idToken);
    return `${doc.end_session_endpoint}?${q}`;
  } catch { return null; }
}

// ---------- Map claim → danh sách nhóm ----------
export function groupsFrom(claims) {
  const raw = claims[SSO.groupClaim] ?? claims.realm_access?.roles ?? [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  return arr.map((g) => String(g).replace(/^\//, '').trim()).filter(Boolean);
}

// Nhóm "os-devops-team" → project "devops-team" (prefix cấu hình được)
export function projectNamesFrom(groups) {
  const out = new Set(SSO.defaultProjects);
  for (const g of groups) {
    if (!SSO.projectPrefix) out.add(g);
    else if (g.startsWith(SSO.projectPrefix)) out.add(g.slice(SSO.projectPrefix.length));
  }
  return [...out].filter(Boolean);
}
