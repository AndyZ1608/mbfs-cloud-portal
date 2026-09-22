// security.js — Security headers + rate limiting, không dùng thư viện ngoài.
const SECURE = String(process.env.SECURE_COOKIES || '').toLowerCase() === 'true';

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // SPA build sẵn: script/style tự phục vụ; 'unsafe-inline' cần cho style inline của React
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Nova console WebSocket hosts may differ from the CMP origin.
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '));
  next();
}

// ---------- Rate limit (cửa sổ trượt, lưu RAM) ----------
const buckets = new Map(); // key -> [timestamps]
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [k, arr] of buckets) {
    const keep = arr.filter((t) => t > cutoff);
    keep.length ? buckets.set(k, keep) : buckets.delete(k);
  }
}, 300000).unref?.();

const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

export function rateLimit({ windowSec, max, keyPrefix = '', message = 'Quá nhiều yêu cầu, thử lại sau ít phút' }) {
  const windowMs = windowSec * 1000;
  return (req, res, next) => {
    if (max <= 0) return next();
    const key = keyPrefix + ':' + ipOf(req);
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      const retry = Math.ceil((windowMs - (now - arr[0])) / 1000);
      res.setHeader('Retry-After', String(retry));
      console.warn(`[ratelimit] chặn ${key} (${arr.length}/${max} trong ${windowSec}s)`);
      return res.status(429).json({ error: `${message} (thử lại sau ${retry}s)` });
    }
    arr.push(now);
    buckets.set(key, arr);
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - arr.length)));
    next();
  };
}

export const loginLimiter = () => rateLimit({
  windowSec: Number(process.env.RATE_LOGIN_WINDOW_SEC) || 300,
  max: Number(process.env.RATE_LOGIN_MAX ?? 10),
  keyPrefix: 'login',
  message: 'Đăng nhập sai quá nhiều lần',
});

export const apiLimiter = () => rateLimit({
  windowSec: Number(process.env.RATE_API_WINDOW_SEC) || 60,
  max: Number(process.env.RATE_API_MAX ?? 600),
  keyPrefix: 'api',
});

export const rateLimitStats = () => ({ tracked_keys: buckets.size });
