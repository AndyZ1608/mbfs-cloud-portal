import { formatBytesPerSecond, formatPercent } from './model.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE_STEPS = { '1h': 10 * MINUTE, '6h': HOUR, '24h': 4 * HOUR, '7d': DAY };

export function formatChartValue(value, unit, locale = 'en-US') {
  return unit === 'percent' ? formatPercent(value, locale) : formatBytesPerSecond(value, locale);
}

export function formatFullTimestamp(timestamp, locale = 'en-US') {
  if (!Number.isFinite(timestamp)) return 'N/A';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(timestamp));
}

export function formatSampleTime(timestamp, locale = 'en-US') {
  if (!Number.isFinite(timestamp)) return 'N/A';
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(timestamp));
}

export function formatAxisTimestamp(timestamp, range, locale = 'en-US') {
  if (!Number.isFinite(timestamp)) return 'N/A';
  const options = range === '1h' || range === '6h'
    ? { hour: '2-digit', minute: '2-digit' }
    : range === '24h'
      ? { month: 'short', day: 'numeric', hour: '2-digit' }
      : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, options).format(new Date(timestamp));
}

function alignUp(timestamp, step) {
  const date = new Date(timestamp);
  if (step >= DAY) {
    const days = Math.round(step / DAY);
    date.setHours(0, 0, 0, 0);
    while (date.getTime() < timestamp) date.setDate(date.getDate() + days);
  } else if (step >= HOUR) {
    const hours = Math.round(step / HOUR);
    date.setMinutes(0, 0, 0);
    date.setHours(Math.floor(date.getHours() / hours) * hours);
    while (date.getTime() < timestamp) date.setHours(date.getHours() + hours);
  } else {
    const minutes = Math.round(step / MINUTE);
    date.setSeconds(0, 0);
    date.setMinutes(Math.floor(date.getMinutes() / minutes) * minutes);
    while (date.getTime() < timestamp) date.setMinutes(date.getMinutes() + minutes);
  }
  return date.getTime();
}

export function chartTimeTicks(first, last, range, plotWidth) {
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
  if (first === last) return [first];
  const labelWidth = range === '24h' ? 110 : range === '7d' ? 72 : 60;
  const maxTicks = Math.max(1, Math.floor(plotWidth / labelWidth));
  if (maxTicks === 1) return [first];
  let step = BASE_STEPS[range] || BASE_STEPS['1h'];
  while ((last - first) / step > maxTicks - 1) step *= 2;
  const ticks = [];
  for (let time = alignUp(first, step), count = 0; time <= last && count < 20; count++) {
    ticks.push(time);
    const date = new Date(time);
    if (step >= DAY) date.setDate(date.getDate() + Math.round(step / DAY));
    else if (step >= HOUR) date.setHours(date.getHours() + Math.round(step / HOUR));
    else date.setMinutes(date.getMinutes() + Math.round(step / MINUTE));
    if (date.getTime() <= time) break;
    time = date.getTime();
  }
  return ticks.length >= 2 ? ticks : [first, last];
}

export function chartSamples(points) {
  return (Array.isArray(points) ? points : [])
    .filter((point) => Number.isFinite(point?.timestamp))
    .map((point) => ({ ...point, value: Number.isFinite(point.value) ? point.value : null }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function nearestIndex(sorted, target, select = (value) => value) {
  if (!sorted.length) return -1;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (select(sorted[middle]) < target) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  if (low === sorted.length) return sorted.length - 1;
  return Math.abs(select(sorted[low]) - target) < Math.abs(select(sorted[low - 1]) - target) ? low : low - 1;
}

export function recordedTimestamps(series) {
  return [...new Set(series.flatMap(({ samples }) => samples
    .filter((point) => Number.isFinite(point.value)).map((point) => point.timestamp)))].sort((a, b) => a - b);
}

export function nearestRecordedTimestamp(times, target) {
  const index = nearestIndex(times, target);
  return index < 0 ? null : times[index];
}

export function hoverTimestampAt(times, clientX, { left, width, viewWidth, plotLeft, plotRight }) {
  if (!times.length || !Number.isFinite(clientX) || !Number.isFinite(width) || width <= 0) return null;
  const position = (clientX - left) * viewWidth / width;
  if (position < plotLeft || position > plotRight) return null;
  const target = times[0] + ((position - plotLeft) / (plotRight - plotLeft)) * (times.at(-1) - times[0]);
  return nearestRecordedTimestamp(times, target);
}

export function sampleTolerance(samples) {
  if (samples.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i].timestamp - samples[i - 1].timestamp;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return Math.min(gaps[Math.floor(gaps.length / 2)] * 0.49, 2 * MINUTE);
}

export function recordedValuesAt(series, timestamp) {
  return series.flatMap((line) => {
    const index = nearestIndex(line.samples, timestamp, (point) => point.timestamp);
    if (index < 0) return [];
    const point = line.samples[index];
    if (!Number.isFinite(point.value)
      || Math.abs(point.timestamp - timestamp) > (line.toleranceMs ?? sampleTolerance(line.samples))) return [];
    return [{ key: line.key, label: line.label, color: line.color, point }];
  });
}

export function chartMaximum(values, unit) {
  const maximum = Math.max(0, ...values.filter((value) => Number.isFinite(value)));
  if (unit === 'percent') return Math.max(100, Math.ceil(maximum / 20) * 20);
  if (maximum === 0) return 1;
  const power = 10 ** Math.floor(Math.log10(maximum));
  return [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= maximum) || maximum;
}
