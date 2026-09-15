import crypto from 'node:crypto';
import { config } from './config.js';

const material = process.env.DATA_ENCRYPTION_KEY || config.sessionSecret;
const key = material ? crypto.createHash('sha256').update(material).digest() : null;

export const encryptionConfigured = () => Boolean(key);

export function seal(value) {
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function unseal(value) {
  if (!key || !value) return null;
  const [version, iv, tag, ciphertext] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

