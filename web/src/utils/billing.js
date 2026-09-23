import { getLocale, intlLocale, text } from '../i18n/index.js';

const vndFormatters = {
  vi: new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0, minimumFractionDigits: 0 }),
  en: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'VND', currencyDisplay: 'code', maximumFractionDigits: 0, minimumFractionDigits: 0 }),
};

const DATE_FIELD = /(date|time|as_of|updated|created|period_(start|end))/i;
const MONEY_FIELD = /(^|[._])(cost|amount|charge|price|total)([._]|$)/i;

export const BILLING_FIELDS = {
  totalCost: ['total_cost', 'cost.total', 'costs.total', 'billing.total_cost', 'amount'],
  cpuCost: ['cpu_cost', 'cost.cpu', 'costs.cpu', 'cost_breakdown.cpu', 'cost_breakdown.cpu_cost'],
  ramCost: ['ram_cost', 'memory_cost', 'cost.ram', 'cost.memory', 'costs.ram', 'cost_breakdown.ram', 'cost_breakdown.ram_cost'],
  ssdCost: ['ssd_cost', 'storage_cost', 'disk_cost', 'cost.ssd', 'cost.storage', 'costs.ssd', 'cost_breakdown.ssd', 'cost_breakdown.ssd_cost'],
  vmCount: ['vm_count', 'instance_count', 'instances_count', 'total_instances'],
  activeVmCount: ['active_vm_count', 'active_instance_count', 'active_instances', 'running_vm_count'],
  projectName: ['project_name', 'project.name'],
  projectId: ['project_id', 'project.id', 'tenant_id'],
  periodStart: ['period_start', 'period.start', 'billing_period.start'],
  periodEnd: ['period_end', 'period.end', 'billing_period.end'],
  timezone: ['timezone', 'time_zone'],
  currency: ['currency'],
  dataQuality: ['data_quality_status', 'data_quality.status', 'quality_status'],
  asOf: ['as_of'],
  costComplete: ['cost_complete'],
  estimated: ['estimated'],
  unratedSegments: ['unrated_segments'],
  unattributedCost: ['project_unattributed_cost', 'unattributed_cost'],
  name: ['name', 'instance_name', 'display_name'],
  instanceId: ['instance_id', 'id', 'uuid', 'instance_uuid'],
  status: ['status', 'vm_state', 'state'],
  vcpus: ['vcpus', 'vcpu', 'vcpu_count', 'cpu_count'],
  ramGib: ['ram_gib', 'memory_gib', 'ram_gb', 'memory_gb'],
  ramMib: ['ram_mb', 'memory_mb'],
  ssdGib: ['ssd_gib', 'ssd_gb', 'storage_gib', 'storage_gb', 'disk_gb', 'disk'],
};

export function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

export function labelFor(key) {
  return String(key).replaceAll('_', ' ').replaceAll('.', ' · ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function pathValue(object, path) {
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);
}

function objectCandidates(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const preferred = ['summary', 'billing', 'instance', 'data', 'result'];
  const candidates = [];
  const queue = [payload];
  const visited = new Set();
  while (queue.length && candidates.length < 12) {
    const object = queue.shift();
    if (!object || typeof object !== 'object' || Array.isArray(object) || visited.has(object)) continue;
    visited.add(object);
    candidates.push(object);
    for (const key of preferred) queue.push(object[key]);
  }
  return candidates;
}

export function billingValue(payload, aliases) {
  for (const object of objectCandidates(payload)) {
    for (const alias of aliases) {
      const value = pathValue(object, alias);
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

export function firstBillingValue(payloads, aliases) {
  for (const payload of payloads) {
    const value = billingValue(payload, aliases);
    if (value !== undefined) return value;
  }
  return undefined;
}

// Decimal strings are rounded before conversion, so large values do not lose precision through Number.
export function decimalToRoundedBigInt(value) {
  if (typeof value === 'bigint') return value;
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const negative = match[1] === '-';
  let rounded = BigInt(match[2]);
  if (match[3]?.[0] >= '5') rounded += 1n;
  return negative && rounded !== 0n ? -rounded : rounded;
}

export function formatVnd(value) {
  const rounded = decimalToRoundedBigInt(value);
  return rounded === null ? '—' : vndFormatters[getLocale()].format(rounded);
}

export function formatDateTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date);
}

export function displayBillingValue(value, key = '') {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return text(value ? 'common.yes' : 'common.no');
  if (MONEY_FIELD.test(key) && key !== 'currency') return formatVnd(value);
  if (DATE_FIELD.test(key)) return formatDateTime(value);
  if (typeof value === 'number') return value.toLocaleString(intlLocale(), { maximumFractionDigits: 2 });
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function flattenScalars(value, prefix = '', depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return [];
  const result = [];
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (isScalar(child)) result.push([fullKey, child]);
    else if (!Array.isArray(child)) result.push(...flattenScalars(child, fullKey, depth + 1));
  }
  return result;
}

export function findInstances(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['instances', 'items', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
    const nested = findInstances(payload[key]);
    if (nested.length) return nested;
  }
  return [];
}

export function instanceId(payload) {
  const value = billingValue(payload, BILLING_FIELDS.instanceId);
  return value === undefined ? null : String(value);
}

export function hasInstanceCosts(payload) {
  return [BILLING_FIELDS.cpuCost, BILLING_FIELDS.ramCost, BILLING_FIELDS.ssdCost, BILLING_FIELDS.totalCost]
    .every((aliases) => billingValue(payload, aliases) !== undefined);
}
