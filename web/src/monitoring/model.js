export const MONITORING_RANGES = ['1h', '6h', '24h', '7d'];

const SUMMARY_KEYS = [
  'cpuPercent', 'memoryPercent', 'memoryUsedBytes', 'memoryTotalBytes',
  'diskReadBps', 'diskWriteBps', 'networkRxBps', 'networkTxBps', 'reachable',
];
export const SERIES_KEYS = [
  'cpuPercent', 'memoryPercent', 'diskReadBps', 'diskWriteBps', 'networkRxBps', 'networkTxBps',
];

export function emptyVmMonitoring() {
  return {
    summary: Object.fromEntries(SUMMARY_KEYS.map((key) => [key, null])),
    series: Object.fromEntries(SERIES_KEYS.map((key) => [key, []])),
  };
}

export function monitoringScopeKey(projectId, instanceId, range) {
  return JSON.stringify([projectId, instanceId, range]);
}

export function hasMonitoringData(data) {
  return SUMMARY_KEYS.some((key) => {
    const value = data?.summary?.[key];
    return typeof value === 'boolean' || value === 'unknown' || typeof value === 'number' && Number.isFinite(value);
  }) || SERIES_KEYS.some((key) => Array.isArray(data?.series?.[key]) && data.series[key].some((point) =>
    Number.isFinite(point?.timestamp) && Number.isFinite(point?.value)));
}

export function formatPercent(value, locale = 'en-US') {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%` : 'N/A';
}

function formatBytesValue(value, locale, suffix) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (Math.abs(amount) >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(amount)} ${units[unit]}${suffix}`;
}

export const formatBytes = (value, locale = 'en-US') => formatBytesValue(value, locale, '');
export const formatBytesPerSecond = (value, locale = 'en-US') => formatBytesValue(value, locale, '/s');

export function chartPoints(series, limit = 600) {
  if (!Array.isArray(series)) return [];
  const valid = series.filter((point) => Number.isFinite(point?.timestamp) && Number.isFinite(point?.value))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (valid.length <= limit) return valid;
  const stride = Math.ceil((valid.length - 1) / (limit - 1));
  const sampled = valid.filter((_point, index) => index % stride === 0);
  if (sampled.at(-1) !== valid.at(-1)) sampled.push(valid.at(-1));
  return sampled;
}
