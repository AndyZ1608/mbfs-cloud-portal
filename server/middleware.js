import crypto from 'node:crypto';
import { OSError } from './openstack.js';
import { config } from './config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requestContext(req, res, next) {
  const supplied = req.get('x-request-id');
  req.id = supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// Cookie-authenticated writes must be initiated by our SPA/API client. The custom
// header forces browsers to perform a CORS preflight and blocks cross-site forms.
export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.path === '/auth/websso/callback') return next(); // signed Keystone POST flow

  const site = req.get('sec-fetch-site');
  if (site === 'cross-site') return next(new OSError(403, 'Yêu cầu cross-site bị từ chối', 'csrf_rejected'));
  if (req.get('x-cmp-request') !== '1') {
    return next(new OSError(403, 'Thiếu tiêu đề bảo vệ CSRF', 'csrf_rejected'));
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.session?.os) return next(new OSError(401, 'Chưa đăng nhập', 'authentication_required'));
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    const roles = req.session?.os?.roles || [];
    if (!roles.includes(role)) return next(new OSError(403, `Cần role ${role} để dùng chức năng này`, 'permission_denied'));
    next();
  };
}

export function errorHandler(err, req, res, _next) {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const expose = status < 500 || err.expose === true;
  if (status >= 500) console.error(`[error] request_id=${req.id}`, err);
  res.status(status).json({
    error: expose ? (err.message || 'Lỗi máy chủ nội bộ') : 'Lỗi máy chủ nội bộ',
    code: err.code || (status >= 500 ? 'internal_error' : 'request_error'),
    requestId: req.id,
    ...(['network_partial_failure', 'network_edit_partial_failure'].includes(err.code) && err.resourceIds ? { resourceIds: err.resourceIds } : {}),
  });
}

export function clientIp(req) {
  // Express only honors forwarding headers when trust proxy is explicitly enabled.
  return config.trustProxy ? req.ip : (req.socket?.remoteAddress || req.ip || 'unknown');
}
