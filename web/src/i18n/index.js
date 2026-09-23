import vi from './locales/vi.js';
import en from './locales/en.js';

export const LOCALE_STORAGE_KEY = 'cmp.locale';
export const resources = { vi, en };
let currentLocale = 'vi';

export function normalizeLocale(value) {
  return value === 'en' ? 'en' : 'vi';
}

export function initialLocale(storage) {
  try { return normalizeLocale((storage === undefined ? globalThis.localStorage : storage)?.getItem(LOCALE_STORAGE_KEY)); }
  catch { return 'vi'; }
}

export function getLocale() { return currentLocale; }
export function setRuntimeLocale(locale) { currentLocale = normalizeLocale(locale); }

export function applyLocale(locale, environment = globalThis) {
  const selected = normalizeLocale(locale);
  setRuntimeLocale(selected);
  try { environment.document?.documentElement?.setAttribute('lang', selected); } catch { /* non-browser render */ }
  try { environment.localStorage?.setItem(LOCALE_STORAGE_KEY, selected); } catch { /* private storage */ }
  return selected;
}

export function interpolate(value, variables = {}) {
  return String(value).replace(/{{\s*([\w.]+)\s*}}/g, (_match, name) => {
    const replacement = name.split('.').reduce((item, part) => item?.[part], variables);
    return replacement == null ? '' : String(replacement);
  });
}

export function translate(locale, key, variables) {
  const selected = resources[normalizeLocale(locale)];
  const count = Number(variables?.count);
  const pluralKey = variables?.count !== undefined && Number.isFinite(count)
    ? `${key}.${count === 1 ? 'one' : 'other'}` : null;
  const value = (pluralKey && (selected[pluralKey] ?? vi[pluralKey])) ?? selected[key] ?? vi[key];
  return value === undefined ? key : interpolate(value, variables);
}

export function text(key, variables) {
  return translate(currentLocale, key, variables);
}

export function intlLocale(locale = currentLocale) {
  return normalizeLocale(locale) === 'en' ? 'en-US' : 'vi-VN';
}
