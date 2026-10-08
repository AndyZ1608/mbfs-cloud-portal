import { config } from '../config.js';
import { MonitoringClient, HISTORY_METRICS } from './client.js';
import { MonitoringError } from './errors.js';

export const MONITORING_RANGES = Object.freeze({
  '1h': { hours: 1, stepSeconds: 60 },
  '6h': { hours: 6, stepSeconds: 60 },
  '24h': { hours: 24, stepSeconds: 120 },
  '7d': null, // Admin history is bounded to 48 hours; never synthesize a seven-day chart.
});

export const INSTANCE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const comparableId = (value) => {
  if (typeof value !== 'string') return '';
  const compact = value.replaceAll('-', '');
  return /^[0-9a-f]{32}$/i.test(compact) ? compact.toLowerCase() : value.toLowerCase();
};
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function emptyMonitoringData() {
  return {
    summary: { cpuPercent: null, memoryPercent: null, memoryUsedBytes: null, memoryTotalBytes: null,
      diskReadBps: null, diskWriteBps: null, networkRxBps: null, networkTxBps: null, reachable: null },
    series: Object.fromEntries(Object.keys(HISTORY_METRICS).map((key) => [key, []])),
    historyUnsupported: false, partial: false,
  };
}

function assertIdentity(payload, instanceId, projectId) {
  const metadata = payload?.metadata;
  if (!asObject(metadata) || comparableId(metadata.instance_id) !== comparableId(instanceId)
    || comparableId(metadata.project_id) !== comparableId(projectId)) {
    throw new MonitoringError(502, 'monitoring_identity_mismatch', 'Monitoring trả về sai định danh máy ảo.');
  }
}

export function normalizeSnapshot(payload, instanceId, projectId) {
  if (payload === null) return emptyMonitoringData();
  assertIdentity(payload, instanceId, projectId);
  if (!asObject(payload.metrics)) throw new MonitoringError(502, 'monitoring_invalid_response', 'Monitoring trả về dữ liệu không hợp lệ.');
  const metrics = payload.metrics;
  const data = emptyMonitoringData();
  data.summary.cpuPercent = numeric(metrics.cpu_percent);
  data.summary.memoryPercent = numeric(metrics.memory_used_percent);
  data.summary.diskReadBps = numeric(metrics.disk_read_bytes_per_second);
  data.summary.diskWriteBps = numeric(metrics.disk_write_bytes_per_second);
  data.summary.networkRxBps = numeric(metrics.network_rx_bytes_per_second);
  data.summary.networkTxBps = numeric(metrics.network_tx_bytes_per_second);
  // QEMU RSS is host process memory, not guest-used memory; reachability is not provided.
  return data;
}

export function normalizeHistory(payload, key, instanceId, projectId) {
  if (payload === null) return [];
  assertIdentity(payload, instanceId, projectId);
  const spec = HISTORY_METRICS[key];
  if (payload.metric !== spec.metric || payload.unit !== spec.unit || payload.null_is_missing !== true
    || !Array.isArray(payload.points) || payload.points.length > 2000) {
    throw new MonitoringError(502, 'monitoring_invalid_response', 'Monitoring trả về lịch sử không hợp lệ.');
  }
  return payload.points.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || point[0] < 0
      || point[1] !== null && numeric(point[1]) === null) {
      throw new MonitoringError(502, 'monitoring_invalid_response', 'Monitoring trả về mẫu dữ liệu không hợp lệ.');
    }
    return { timestamp: point[0] * 1000, value: point[1] };
  }).sort((a, b) => a.timestamp - b.timestamp);
}

async function boundedHistories(keys, load) {
  const results = Array(keys.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, keys.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= keys.length) return;
      try { results[index] = { value: await load(keys[index]) }; }
      catch (error) { results[index] = { error }; }
    }
  }));
  return results;
}

export class MonitoringService {
  constructor(client) { this.client = client; }

  async metrics(instanceId, projectId, range, requestId) {
    const snapshot = await this.client.snapshot(instanceId, requestId);
    const data = normalizeSnapshot(snapshot, instanceId, projectId);
    const historyOptions = MONITORING_RANGES[range];
    if (!historyOptions) data.historyUnsupported = true;
    if (!snapshot || !historyOptions) return data;
    const keys = Object.keys(HISTORY_METRICS);
    const histories = await boundedHistories(keys, (key) => this.client.history(instanceId, key, historyOptions, requestId));
    for (let i = 0; i < keys.length; i++) {
      const result = histories[i];
      if (result.error) {
        if (result.error.code === 'monitoring_identity_mismatch') throw result.error;
        data.partial = true;
      } else {
        try { data.series[keys[i]] = normalizeHistory(result.value, keys[i], instanceId, projectId); }
        catch (error) {
          if (error.code === 'monitoring_identity_mismatch') throw error;
          data.partial = true;
        }
      }
    }
    return data;
  }
}

export function createMonitoringService(monitoringConfig = config.monitoring, options = {}) {
  const apiKey = options.apiKey ?? process.env.MONITORING_API_KEY;
  if (!monitoringConfig.enabled || !monitoringConfig.baseUrl || !apiKey) return null;
  // TODO: Replace only this admin-key adapter when Monitoring supports Keystone-scoped VM metrics.
  return new MonitoringService(new MonitoringClient({ baseUrl: monitoringConfig.baseUrl,
    timeoutMs: monitoringConfig.timeoutMs, apiKey, fetchImpl: options.fetchImpl }));
}
