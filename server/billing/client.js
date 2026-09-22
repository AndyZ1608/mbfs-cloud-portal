import { BillingError } from './errors.js';

const RESPONSE_LIMIT_BYTES = 10 * 1024 * 1024;
const logValue = (value) => String(value || '-').replace(/[\r\n\t]/g, '_').slice(0, 256);

async function readLimitedBody(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_LIMIT_BYTES) throw new BillingError(502, 'billing_invalid_response', 'Billing service trả về dữ liệu quá lớn');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new BillingError(502, 'billing_invalid_response', 'Billing service trả về dữ liệu quá lớn');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export class BillingClient {
  constructor({ baseUrl, timeoutMs, fetchImpl = fetch, logger = console }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async get(path, { token, requestId, projectId, instanceId } = {}) {
    if (!token) throw new BillingError(401, 'authentication_required', 'Chưa đăng nhập');
    const endpoint = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    let response;

    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Auth-Token': token,
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      const elapsed = Date.now() - started;
      const timedOut = error?.name === 'AbortError' || controller.signal.aborted;
      this.logger.warn(`[billing] request_id=${logValue(requestId)} endpoint=${logValue(endpoint)} instance_id=${logValue(instanceId)} project_id=${logValue(projectId)} status=network_error ms=${elapsed} error_type=${timedOut ? 'timeout' : 'network'}`);
      if (timedOut) throw new BillingError(504, 'billing_timeout', 'Billing service không phản hồi kịp thời');
      throw new BillingError(503, 'billing_unavailable', 'Billing service hiện không khả dụng');
    } finally {
      clearTimeout(timer);
    }

    const elapsed = Date.now() - started;
    this.logger.info(`[billing] request_id=${logValue(requestId)} endpoint=${logValue(endpoint)} instance_id=${logValue(instanceId)} project_id=${logValue(projectId)} status=${response.status} ms=${elapsed}`);

    if (response.status === 401) throw new BillingError(401, 'billing_unauthorized', 'Phiên OpenStack đã hết hạn hoặc không hợp lệ');
    if (response.status === 403) throw new BillingError(403, 'billing_forbidden', 'Bạn không có quyền xem dữ liệu Billing này');
    if (response.status === 404) throw new BillingError(404, 'billing_not_found', 'Không tìm thấy bản ghi Billing');
    if (!response.ok) throw new BillingError(503, 'billing_unavailable', 'Billing service hiện không khả dụng');

    const length = Number(response.headers.get('content-length') || 0);
    if (length > RESPONSE_LIMIT_BYTES) throw new BillingError(502, 'billing_invalid_response', 'Billing service trả về dữ liệu quá lớn');
    let text;
    try { text = await readLimitedBody(response); }
    catch (error) {
      if (error instanceof BillingError) throw error;
      throw new BillingError(502, 'billing_invalid_response', 'Không đọc được phản hồi từ Billing service');
    }
    let data;
    try { data = JSON.parse(text); }
    catch { throw new BillingError(502, 'billing_invalid_response', 'Billing service trả về dữ liệu không hợp lệ'); }
    if (data === null || typeof data !== 'object') {
      throw new BillingError(502, 'billing_invalid_response', 'Billing service trả về cấu trúc dữ liệu không hợp lệ');
    }
    return data;
  }
}
