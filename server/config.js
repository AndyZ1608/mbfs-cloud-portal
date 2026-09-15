// Centralized process configuration and startup validation.
const bool = (name, fallback = false) => {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const integer = (name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  port: integer('PORT', 8080, { min: 1, max: 65535 }),
  cloudName: process.env.CLOUD_NAME || 'MBFS Cloud',
  region: process.env.OS_REGION_NAME || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionTtlMs: integer('SESSION_TTL_SEC', 8 * 3600, { min: 300, max: 7 * 86400 }) * 1000,
  secureCookies: bool('SECURE_COOKIES'),
  trustProxy: bool('TRUST_PROXY'),
  providerTimeoutMs: integer('OS_REQUEST_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000 }),
  providerUploadTimeoutMs: integer('OS_UPLOAD_TIMEOUT_MS', 3_600_000, { min: 60_000, max: 86_400_000 }),
});

export function validateConfig() {
  const errors = [];
  const warnings = [];

  if (config.env === 'production' && config.sessionSecret.length < 32) {
    errors.push('SESSION_SECRET must be set to at least 32 characters in production');
  }
  if (config.env === 'production' && !config.secureCookies) {
    warnings.push('SECURE_COOKIES is not enabled; session cookies may be sent over plain HTTP');
  }
  if (config.env === 'production' && !(process.env.DATA_ENCRYPTION_KEY || config.sessionSecret)) {
    errors.push('DATA_ENCRYPTION_KEY or SESSION_SECRET is required to encrypt stored infrastructure secrets');
  }
  if (process.env.OS_INSECURE === 'true' || process.env.SSO_INSECURE === 'true') {
    warnings.push('TLS certificate verification is disabled for at least one integration');
  }
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  return warnings;
}
