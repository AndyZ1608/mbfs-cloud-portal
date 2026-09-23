import { resources, translate } from './index.js';

export function noticeTitle(notice, locale) {
  const key = `notifications.${notice?.code}.title`;
  if (resources[locale]?.[key]) return translate(locale, key, notice.values);
  const legacy = typeof notice?.title === 'string' ? notice.title : '';
  return locale === 'vi' ? legacy : translate(locale, 'notifications.legacyTitle');
}

export function noticeDetail(notice, locale) {
  const key = `notifications.${notice?.code}.detail`;
  if (resources[locale]?.[key]) return translate(locale, key, notice.values);
  const legacy = typeof notice?.detail === 'string' ? notice.detail : '';
  return locale === 'vi' ? legacy : '';
}
