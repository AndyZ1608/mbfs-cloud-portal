import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { applyLocale, initialLocale, normalizeLocale, setRuntimeLocale, translate } from './index.js';

const LocaleContext = createContext({ locale: 'vi', setLocale: () => {}, t: (key, variables) => translate('vi', key, variables) });

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(() => {
    const saved = initialLocale();
    setRuntimeLocale(saved);
    return saved;
  });

  useEffect(() => {
    applyLocale(locale);
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale: (next) => {
      const normalized = normalizeLocale(next);
      setRuntimeLocale(normalized);
      setLocaleState(normalized);
    },
    t: (key, variables) => translate(locale, key, variables),
  }), [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  return useContext(LocaleContext);
}
