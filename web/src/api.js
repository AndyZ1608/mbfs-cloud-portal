import { getLocale, intlLocale, resources, text } from './i18n/index.js';
import { imageFlavorWarningText } from './instanceError.js';

export class ApiError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function apiErrorMessage(data, status) {
  const code = data?.code;
  if (code === 'FLAVOR_DISK_TOO_SMALL' || code === 'FLAVOR_RAM_TOO_SMALL' || code === 'IMAGE_SIZE_EXCEEDS_VOLUME') {
    const context = data?.context || {};
    const fields = code === 'FLAVOR_DISK_TOO_SMALL' ? ['required_disk_gb', 'flavor_disk_gb']
      : code === 'FLAVOR_RAM_TOO_SMALL' ? ['required_ram_mb', 'flavor_ram_mb']
        : ['required_disk_gb', 'requested_volume_gb'];
    if (fields.every((field) => Number.isFinite(context[field]) && context[field] > 0)) {
      return imageFlavorWarningText(text, { code, context });
    }
    return text(`instance.error.code.${code}`);
  }
  if (code === 'network_partial_failure') return text('errors.network_partial_failure', {
    networkId: data?.resourceIds?.networkId || '—',
    subnetId: data?.resourceIds?.subnetId || '—',
  });
  if (code === 'network_edit_partial_failure') return `${text('errors.network_edit_partial_failure')} (${data?.resourceIds?.networkId || '—'} / ${data?.resourceIds?.subnetId || '—'})`;
  if (code === 'vip_delete_assigned') return text('errors.vip_delete_assigned', { count: data?.count ?? '—' });
  if (code === 'vip_partial_failure') return text('errors.vip_partial_failure', {
    count: data?.changed ?? '—', portId: data?.failedPortId || '—',
  });
  if (code && resources.vi[`errors.${code}`]) return text(`errors.${code}`);
  if (status === 401) return text('errors.authentication_required');
  if (status === 403) return text('errors.permission_denied');
  const raw = typeof data?.error === 'string' ? data.error : '';
  if (getLocale() === 'vi') return raw || text('errors.requestFailed');
  // Unknown OpenStack diagnostics may remain in English; never machine-translate them.
  // Vietnamese backend messages are replaced with localized context in English UI.
  return raw && !/[À-ỹ]/u.test(raw)
    ? text('errors.providerMessage', { message: raw })
    : text('errors.requestFailed');
}

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) opts.headers['X-CMP-Request'] = '1';
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && !path.startsWith('/auth/') && data?.code !== 'account_current_password_incorrect') {
    window.location.href = '/login';
    throw new ApiError(text('errors.authentication_required'), { status: 401, code: data?.code, requestId: data?.requestId });
  }
  if (!res.ok) throw new ApiError(apiErrorMessage(data, res.status), {
    status: res.status, code: data?.code, requestId: data?.requestId,
  });
  return data;
}

export function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(intlLocale(), { hour12: false }); } catch { return s; }
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: v >= 10 || i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

export function ramGB(mb) {
  if (mb == null) return '—';
  return mb >= 1024
    ? `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: mb % 1024 ? 1 : 0 }).format(mb / 1024)} GB`
    : `${new Intl.NumberFormat(intlLocale()).format(mb)} MB`;
}

// Trích danh sách IP của server: [{ip, type, net}]
export function serverIps(server) {
  const out = [];
  const addrs = server?.addresses;
  if (!addrs || typeof addrs !== 'object' || Array.isArray(addrs)) return out;
  for (const [net, list] of Object.entries(addrs)) {
    for (const a of Array.isArray(list) ? list : []) {
      if (a && typeof a.addr === 'string') out.push({ ip: a.addr, type: a['OS-EXT-IPS:type'] || 'fixed', net });
    }
  }
  return out;
}
