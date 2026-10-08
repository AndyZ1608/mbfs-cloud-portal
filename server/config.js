// Centralized process and YAML application configuration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

export function normalizeBillingConfig(value = {}) {
  const enabled = value.enabled === true;
  const timeoutSeconds = Number(value.timeout_seconds ?? 10);
  const rawBaseUrl = String(value.base_url || '').trim();
  const errors = [];

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
    errors.push('billing.timeout_seconds must be between 1 and 120');
  }

  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  if (enabled && baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) errors.push('billing.base_url must use http:// or https://');
      if (parsed.username || parsed.password) errors.push('billing.base_url must not contain credentials');
      if (parsed.search || parsed.hash) errors.push('billing.base_url must not contain a query string or fragment');
    } catch {
      errors.push('billing.base_url must be an absolute URL including http:// or https://');
    }
  }

  return { enabled, baseUrl, timeoutMs: timeoutSeconds * 1000, errors };
}

export function normalizeMonitoringConfig(value = {}) {
  return { enabled: value.enabled === true };
}

export function loadApplicationConfig(filePath = process.env.CMP_CONFIG_FILE || path.join(__dirname, 'config', 'application.yml')) {
  let document;
  try {
    document = parseYaml(fs.readFileSync(filePath, 'utf8')) || {};
  } catch (error) {
    throw new Error(`Cannot load CMP application config ${filePath}: ${error.message}`);
  }
  const billing = normalizeBillingConfig(document.billing);
  const monitoring = normalizeMonitoringConfig(document.monitoring);
  return Object.freeze({ filePath, billing: Object.freeze(billing), monitoring: Object.freeze(monitoring) });
}

const application = loadApplicationConfig();

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
  imageUploadTempDir: process.env.IMAGE_UPLOAD_TEMP_DIR || path.join(os.tmpdir(), 'cmp-image-uploads'),
  applicationConfigFile: application.filePath,
  billing: application.billing,
  monitoring: application.monitoring,
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
  if (process.env.OS_INSECURE === 'true') warnings.push('OpenStack TLS certificate verification is disabled');
  if (process.env.SSO_ENABLED === 'true' && process.env.SSO_INSECURE === 'true') {
    errors.push('SSO_INSECURE is no longer supported; trust the Keycloak CA instead');
  }
  if (process.env.SSO_ENABLED === 'true' && process.env.OS_INSECURE === 'true') {
    errors.push('OS_INSECURE cannot be used with SSO because it disables process-wide TLS verification');
  }
  errors.push(...config.billing.errors);
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  return warnings;
}
