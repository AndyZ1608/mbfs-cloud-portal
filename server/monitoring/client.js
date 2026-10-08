import { MonitoringError } from './errors.js';

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const HISTORY_METRICS = Object.freeze({
  cpuPercent: { metric: 'cpu_percent', unit: '%' },
  memoryPercent: { metric: 'memory_used_percent', unit: '%' },
  diskReadBps: { metric: 'disk_read_bytes_per_second', unit: 'B/s' },
  diskWriteBps: { metric: 'disk_write_bytes_per_second', unit: 'B/s' },
  networkRxBps: { metric: 'network_rx_bytes_per_second', unit: 'B/s' },
  networkTxBps: { metric: 'network_tx_bytes_per_second', unit: 'B/s' },
});

async function readLimitedJson(response) {
  if (Number(response.headers.get('content-length') || 0) > RESPONSE_LIMIT_BYTES) {
    throw new MonitoringError(502, 'monitoring_invalid_response', 'Monitoring trả về dữ liệu quá lớn.');
  }
  const reader = response.body?.getReader?.();
  let text;
  if (!reader) {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_LIMIT_BYTES) {
      throw new MonitoringError(502, 'monitoring_invalid_response', 'Monitoring trả về dữ liệu quá lớn.');
    }
  } else {
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new MonitoringError(502, 'monitoring_invalid_response', 'Monitoring trả về dữ liệu quá lớn.');
      }
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks, bytes).toString('utf8');
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* handled below */ }
  throw new MonitoringError(502, 'monitoring_invalid_response', 'Monitoring trả về dữ liệu không hợp lệ.');
}

export class MonitoringClient {
  constructor({ baseUrl, timeoutMs, apiKey, fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async #request(endpoint, requestId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${endpoint}`, {
        method: 'GET', signal: controller.signal,
        headers: { Accept: 'application/json', 'X-API-Key': this.apiKey,
          ...(requestId ? { 'X-Request-Id': requestId } : {}) },
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new MonitoringError(504, 'monitoring_timeout', 'Dịch vụ Monitoring không phản hồi kịp thời.');
      }
      throw new MonitoringError(503, 'monitoring_unavailable', 'Dịch vụ Monitoring hiện không khả dụng.');
    }

    try {
      if (response.status === 404) return null; // Stopped/unexported VM has no current Libvirt series.
      if (response.status === 409) throw new MonitoringError(503, 'monitoring_ambiguous_instance', 'Chưa thể xác định dữ liệu Monitoring của máy ảo.');
      if (!response.ok) throw new MonitoringError(503, 'monitoring_unavailable', 'Dịch vụ Monitoring hiện không khả dụng.');
      try { return await readLimitedJson(response); }
      catch (error) {
        if (error instanceof MonitoringError) throw error;
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new MonitoringError(504, 'monitoring_timeout', 'Dịch vụ Monitoring không phản hồi kịp thời.');
        }
        throw new MonitoringError(502, 'monitoring_invalid_response', 'Không đọc được dữ liệu Monitoring.');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  snapshot(instanceId, requestId) {
    return this.#request(`/api/v1/admin/instances/${encodeURIComponent(instanceId)}`, requestId);
  }

  history(instanceId, key, { hours, stepSeconds }, requestId) {
    const spec = HISTORY_METRICS[key];
    if (!spec) throw new MonitoringError(400, 'monitoring_metric_invalid', 'Metric không hợp lệ.');
    const params = new URLSearchParams({ metric: spec.metric, hours: String(hours), step_seconds: String(stepSeconds) });
    return this.#request(`/api/v1/admin/instances/${encodeURIComponent(instanceId)}/history?${params}`, requestId);
  }
}
