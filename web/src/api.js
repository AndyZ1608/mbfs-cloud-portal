export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) opts.headers['X-CMP-Request'] = '1';
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.href = '/login';
    throw new Error('Phiên đã hết hạn');
  }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Lỗi HTTP ${res.status}`);
  return data;
}

export function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('vi-VN', { hour12: false }); } catch { return s; }
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function ramGB(mb) {
  if (mb == null) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
}

// Trích danh sách IP của server: [{ip, type, net}]
export function serverIps(server) {
  const out = [];
  const addrs = server.addresses || {};
  for (const [net, list] of Object.entries(addrs)) {
    for (const a of list || []) {
      out.push({ ip: a.addr, type: a['OS-EXT-IPS:type'] || 'fixed', net });
    }
  }
  return out;
}
