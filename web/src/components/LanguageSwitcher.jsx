import React from 'react';
import { Languages } from 'lucide-react';
import { useI18n } from '../i18n/react.jsx';

export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return <label className="language-switcher">
    <Languages size={16} aria-hidden="true" />
    <select value={locale} onChange={(event) => setLocale(event.target.value)} aria-label={t('header.language')}>
      <option value="vi">Tiếng Việt</option>
      <option value="en">English</option>
    </select>
  </label>;
}
