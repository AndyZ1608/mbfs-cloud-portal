import { intlLocale } from './i18n/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOURCE_TYPES = new Set(['instance', 'network', 'subnet', 'port', 'router', 'floating_ip',
  'security_group', 'security_group_rule', 'load_balancer', 'volume', 'snapshot', 'image',
  'project', 'user', 'cmp', 'vip', 'label', 'tag', 'backup', 'keypair']);

// Historical records can lack structured targets. Exact route families identify
// only a type here; the route is never used as a displayed name.
const LEGACY_ROUTES = [
  [/^\/auth\//, 'cmp'], [/^\/servers(?:\/|$)/, 'instance'],
  [/^\/networks\/[^/]+\/subnet$/, 'subnet'], [/^\/networks(?:\/|$)/, 'network'],
  [/^\/ports(?:\/|$)/, 'port'], [/^\/routers(?:\/|$)/, 'router'],
  [/^\/floatingips(?:\/|$)/, 'floating_ip'],
  [/^\/security-group-rules(?:\/|$)/, 'security_group_rule'],
  [/^\/security-groups(?:\/|$)/, 'security_group'],
  [/^\/lb(?:\/|$)/, 'load_balancer'], [/^\/volumes(?:\/|$)/, 'volume'],
  [/^\/snapshots(?:\/|$)/, 'snapshot'], [/^\/images(?:\/|$)/, 'image'],
  [/^\/backup(?:\/|$)/, 'backup'], [/^\/keypairs(?:\/|$)/, 'keypair'],
  [/^\/admin\/projects(?:\/|$)/, 'project'], [/^\/admin\/users(?:\/|$)/, 'user'],
];

export function activityResourceType(event) {
  const action = event?.action || '';
  if (action === 'auth.login' || action === 'auth.logout' || action.startsWith('auth.sso.')
    || /^\/auth\/(?:login|logout|websso\/)/.test(event?.path || '')) return 'cmp';
  if (action.startsWith('subnet.')) return 'subnet';
  if (event?.resource_type === 'account') return 'user';
  if (RESOURCE_TYPES.has(event?.resource_type)) return event.resource_type;
  if (/^\/auth\//.test(event?.path || '')) return 'cmp';
  const prefix = action.split('.')[0];
  if (RESOURCE_TYPES.has(prefix)) return prefix;
  return LEGACY_ROUTES.find(([route]) => route.test(event?.path || ''))?.[1] || 'resource';
}

function readableName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && !UUID.test(name) && !/^[0-9a-f]{32}$/i.test(name) && !name.includes('/') ? name : null;
}

export function activityTarget(event, t, currentNames = {}, currentName = null) {
  const type = activityResourceType(event);
  if (type === 'cmp') return { type: t('activity.type.cmp'), name: t('activity.loginSession') };
  const name = type === 'instance'
    ? vmActivityName(event, t, currentNames, currentName)
    : type === 'subnet' && event?.resource_type === 'network'
      ? readableName(event?.details?.new_name) || t('activity.unknownTarget')
      : readableName(event?.resource_name) || t('activity.unknownTarget');
  return { type: t(`activity.type.${type}`), name };
}

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
