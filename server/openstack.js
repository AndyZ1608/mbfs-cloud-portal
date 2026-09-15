// openstack.js — Keystone v3 auth + generic OpenStack API client
import { mockAuth, mockProjects, mockScope, mockFetch } from './mock.js';
import { config } from './config.js';

export const MOCK = process.env.OS_MOCK === 'true';

const AUTH_URL = normalizeAuthUrl(process.env.OS_AUTH_URL || 'http://127.0.0.1:5000/v3');
const OS_INTERFACE = process.env.OS_INTERFACE || 'public';
const OS_REGION = process.env.OS_REGION_NAME || '';
const NOVA_MV = process.env.OS_COMPUTE_MICROVERSION || '2.60';

if (process.env.OS_INSECURE === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[openstack] OS_INSECURE=true -> BỎ QUA xác thực chứng chỉ TLS (chỉ dùng cho CA nội bộ / self-signed)');
}

function normalizeAuthUrl(u) {
  let s = String(u).trim().replace(/\/+$/, '');
  if (!/\/v3$/.test(s)) s += '/v3';
  return s;
}

export class OSError extends Error {
  constructor(status, message, code = 'provider_error') {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = status < 500 || ['provider_timeout', 'provider_unavailable', 'secret_unavailable'].includes(code);
  }
}

export async function providerFetch(url, options = {}, timeoutMs = config.providerTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new OSError(504, `OpenStack không phản hồi trong ${timeoutMs}ms`, 'provider_timeout');
    }
    throw new OSError(502, 'Không thể kết nối OpenStack', 'provider_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  try {
    const j = JSON.parse(text);
    const k = Object.keys(j)[0];
    const m = j[k] && (j[k].message || j[k].faultstring || j[k].description);
    if (m) return `${m}`;
  } catch { /* not json */ }
  return (text || `HTTP ${res.status}`).slice(0, 400);
}

// ---------- Keystone ----------

export async function passwordAuth(username, password, domainName) {
  if (MOCK) return mockAuth(username, password);
  const body = {
    auth: {
      identity: {
        methods: ['password'],
        password: { user: { name: username, domain: { name: domainName }, password } },
      },
    },
  };
  const res = await providerFetch(`${AUTH_URL}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new OSError(401, 'Sai tên đăng nhập hoặc mật khẩu');
  if (!res.ok) throw new OSError(res.status, await readError(res));
  const token = res.headers.get('x-subject-token');
  const data = await res.json();
  return { token, user: data.token.user };
}

export async function listProjects(unscopedToken) {
  if (MOCK) return mockProjects();
  const res = await providerFetch(`${AUTH_URL}/auth/projects`, {
    headers: { 'X-Auth-Token': unscopedToken, Accept: 'application/json' },
  });
  if (!res.ok) throw new OSError(res.status, await readError(res));
  const data = await res.json();
  return (data.projects || []).filter((p) => p.enabled !== false);
}

export async function scopeToken(unscopedToken, projectId) {
  if (MOCK) return mockScope(projectId, unscopedToken);
  const body = {
    auth: {
      identity: { methods: ['token'], token: { id: unscopedToken } },
      scope: { project: { id: projectId } },
    },
  };
  const res = await providerFetch(`${AUTH_URL}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new OSError(res.status, await readError(res));
  const token = res.headers.get('x-subject-token');
  const t = (await res.json()).token;
  return {
    token,
    user: t.user,
    project: t.project,
    catalog: t.catalog || [],
    roles: (t.roles || []).map((r) => r.name),
    expires: t.expires_at,
  };
}

// ---------- Service endpoint resolution ----------

const SERVICE_TYPES = {
  compute: ['compute'],
  network: ['network'],
  volume: ['volumev3', 'block-storage', 'volume'],
  image: ['image'],
  lb: ['load-balancer'],
  identity: ['identity'],
  object: ['object-store'],
};

export function endpointFor(catalog, svc) {
  const types = SERVICE_TYPES[svc] || [svc];
  for (const t of types) {
    const entry = (catalog || []).find((s) => s.type === t);
    if (!entry) continue;
    let eps = (entry.endpoints || []).filter((e) => e.interface === OS_INTERFACE);
    if (OS_REGION) {
      const byRegion = eps.filter((e) => (e.region || e.region_id) === OS_REGION);
      if (byRegion.length) eps = byRegion;
    }
    if (eps.length) {
      let url = eps[0].url.replace(/\/+$/, '');
      // các route bên dưới tự thêm version prefix, nên chuẩn hoá endpoint gốc
      if (svc === 'image') url = url.replace(/\/v2(\.\d+)?$/, '');
      if (svc === 'network') url = url.replace(/\/v2\.0$/, '');
      if (svc === 'lb') url = url.replace(/\/v2(\.\d+)?$/, '');
      if (svc === 'identity') url = url.replace(/\/v3\/?$/, '');
      return url;
    }
  }
  throw new OSError(
    502,
    `Không tìm thấy endpoint "${svc}" (interface=${OS_INTERFACE}${OS_REGION ? ', region=' + OS_REGION : ''}) trong service catalog`
  );
}

// ---------- Generic fetch ----------

export async function osFetch(sess, svc, path, { method = 'GET', body, rawBody, contentType, headers = {} } = {}) {
  if (MOCK) return mockFetch(svc, method, path, body);
  const base = endpointFor(sess.catalog, svc);
  const h = { 'X-Auth-Token': sess.token, Accept: 'application/json', ...headers };
  if (svc === 'compute') {
    h['OpenStack-API-Version'] = `compute ${NOVA_MV}`;
    h['X-OpenStack-Nova-API-Version'] = NOVA_MV;
  }
  const opts = { method, headers: h };
  if (rawBody !== undefined) {
    // stream thẳng (vd upload image lên Glance) — không buffer trong RAM
    h['Content-Type'] = contentType || 'application/octet-stream';
    opts.body = rawBody;
    opts.duplex = 'half';
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await providerFetch(base + path, opts);
  if (res.status === 401) throw new OSError(401, 'Token đã hết hạn, vui lòng đăng nhập lại');
  if (!res.ok) throw new OSError(res.status, await readError(res));
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) return res.text();
  return res.json();
}
