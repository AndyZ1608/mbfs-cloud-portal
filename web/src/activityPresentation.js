import { intlLocale } from './i18n/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVmActivity(event) {
  return event?.resource_type === 'instance' || event?.action?.startsWith('instance.')
    || event?.instance_id != null || /^\/servers(?:\/|$)/.test(event?.path || '');
}

export function vmActivityId(event) {
  if (!isVmActivity(event)) return null;
  const fromPath = event?.path?.match(/^\/servers\/([^/]+)(?:\/|$)/)?.[1];
  const isInstanceResource = event?.resource_type === 'instance' || event?.action?.startsWith('instance.')
    || /^\/servers(?:\/|$)/.test(event?.path || '');
  return event?.instance_id || (isInstanceResource ? event?.resource_id : null) || fromPath || null;
}

export function vmActivityName(event, t, currentNames = {}, currentName = null) {
  if (!isVmActivity(event) && currentName == null) return '—';
  const id = vmActivityId(event);
  const isInstanceResource = event?.resource_type === 'instance' || event?.action?.startsWith('instance.')
    || /^\/servers(?:\/|$)/.test(event?.path || '');
  // Historical names are authoritative, including after deletion or rename.
  for (const candidate of [event?.instance_name, isInstanceResource && event?.resource_name,
    id && currentNames[id], currentName]) {
    if (typeof candidate === 'string' && candidate.trim() && !UUID.test(candidate.trim())
      && candidate.trim() !== id) return candidate.trim();
  }
  return t('activity.unknownVm');
}

export function activityTimestamp(value) {
  const date = new Date(value);
  if (value == null || value === '' || !Number.isFinite(date.getTime())) return '—';
  const parts = Object.fromEntries(new Intl.DateTimeFormat(intlLocale(), {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function activityStatus(event, t) {
  if (event?.result === 'failure' || event?.status >= 400) {
    return { label: t('instance.activity.result.failure'), tone: 'err' };
  }
  if (event?.result === 'accepted' || event?.status === 202) {
    return { label: t('instance.activity.result.accepted'), tone: 'info' };
  }
  if (event?.result === 'reverted') {
    return { label: t('instance.activity.result.reverted'), tone: 'info' };
  }
  if (event?.result === 'success' || event?.status >= 200 && event?.status < 300) {
    return { label: t('instance.activity.result.success'), tone: 'ok' };
  }
  return { label: '—', tone: 'muted' };
}
