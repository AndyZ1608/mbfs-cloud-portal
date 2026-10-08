import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { normalizeMonitoringConfig } from '../config.js';
import { MonitoringClient, HISTORY_METRICS } from '../monitoring/client.js';
import { MonitoringService, createMonitoringService, emptyMonitoringData, normalizeHistory, normalizeSnapshot } from '../monitoring/service.js';
import { createVmMonitoringRouter } from '../routes/vmMonitoring.js';
import { assertOwned } from '../projectScope.js';
import { requireAuth, errorHandler } from '../middleware.js';

const VM = 'f027ae76-e029-4352-8567-7f4154d408cd';
const PROJECT_A = '94b13345396d4f0bb63587759563cccb';
const PROJECT_B = 'bd6f332645224cdaa53b6205ef0584f4';
const API_KEY = 'test-admin-key-never-returned';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json' } });
const snapshot = (projectId = PROJECT_A) => ({
  metadata: { instance_id: VM, project_id: projectId, instance_name: 'secret-admin-name', compute_host: 'secret-host' },
  metrics: { cpu_percent: 0, memory_used_percent: 61.2, memory_rss_bytes: 987654,
    memory_configured_bytes: 1234567, disk_read_bytes_per_second: null,
    disk_write_bytes_per_second: 0, network_rx_bytes_per_second: 2400000,
    network_tx_bytes_per_second: 890000 },
  collected_at_unix: 1791446577, notes: { internal: 'secret-admin-note' },
});
const history = (key, value = 31.4) => ({
  metadata: { instance_id: VM, project_id: PROJECT_A, compute_host: 'secret-host' },
  metric: HISTORY_METRICS[key].metric, unit: HISTORY_METRICS[key].unit,
  points: [[1791446500, null], [1791446560, value]], null_is_missing: true,
});

async function withRouter({ session, ownerProject = PROJECT_A, monitoringService, monitoringConfig,
  fetchOwnedInstance } = {}, run) {
  const app = express();
  app.use((req, _res, next) => { req.id = 'test-request'; req.session = session ? { os: session } : {}; next(); });
  app.use('/api', requireAuth, createVmMonitoringRouter({
    monitoringConfig: monitoringConfig || normalizeMonitoringConfig({ enabled: true, base_url: 'http://monitoring.internal' }),
    monitoringService,
    fetchOwnedInstance: fetchOwnedInstance || (async (osSession, _service, path) => {
      assert.equal(path, `/servers/${VM}`);
      return assertOwned({ id: VM, project_id: ownerProject }, osSession);
    }),
  }));
  app.use((req, res, next) => { req.id = 'test-request'; next(); });
  app.use(errorHandler);
  const server = app.listen(0);
  try { return await run(`http://127.0.0.1:${server.address().port}/api/servers/${VM}/monitoring`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('configuration validates Monitoring URL/timeout and keeps the key out of public config', () => {
  const valid = normalizeMonitoringConfig({ enabled: true, base_url: 'http://monitoring.internal:8080///', timeout_seconds: 15 });
  assert.deepEqual(valid, { enabled: true, baseUrl: 'http://monitoring.internal:8080', timeoutMs: 15000, errors: [] });
  assert.ok(normalizeMonitoringConfig({ enabled: true, base_url: 'file:///private' }).errors.length);
  assert.ok(normalizeMonitoringConfig({ enabled: true, base_url: 'http://user:pass@monitoring.internal' }).errors.length);
  assert.ok(normalizeMonitoringConfig({ enabled: true, timeout_seconds: 0 }).errors.length);
  assert.equal(Object.keys(valid).some((key) => /api.?key|secret/i.test(key)), false);
});

test('client only calls allowlisted VM endpoints with a backend key and request ID', async () => {
  const calls = [];
  const client = new MonitoringClient({ baseUrl: 'http://monitoring.internal', timeoutMs: 1000, apiKey: API_KEY,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(snapshot()); } });
  await client.snapshot(VM, 'req-1');
  await client.history(VM, 'cpuPercent', { hours: 6, stepSeconds: 60 }, 'req-2');
  assert.equal(calls[0].url, `http://monitoring.internal/api/v1/admin/instances/${VM}`);
  assert.equal(calls[1].url, `http://monitoring.internal/api/v1/admin/instances/${VM}/history?metric=cpu_percent&hours=6&step_seconds=60`);
  assert.equal(calls[0].options.headers['X-API-Key'], API_KEY);
  assert.equal(calls[0].options.headers['X-Request-Id'], 'req-1');
  assert.equal(calls[0].options.method, 'GET');
  assert.throws(() => client.history(VM, 'rawPromQl', { hours: 1, stepSeconds: 60 }), (error) => error.code === 'monitoring_metric_invalid');
  assert.ok(calls.every(({ url }) => !url.includes('/query') && !url.includes('project_id')));
});

test('normalization allowlists real metrics, preserves zero/null, and rejects mismatched identities or units', () => {
  const data = normalizeSnapshot(snapshot(), VM, PROJECT_A);
  assert.equal(data.summary.cpuPercent, 0);
  assert.equal(data.summary.memoryPercent, 61.2);
  assert.equal(data.summary.diskReadBps, null);
  assert.equal(data.summary.diskWriteBps, 0);
  assert.equal(data.summary.networkRxBps, 2400000);
  assert.equal(data.summary.networkTxBps, 890000);
  assert.equal(data.summary.memoryUsedBytes, null, 'QEMU RSS is not guest memory');
  assert.equal(data.summary.reachable, null);
  assert.equal(JSON.stringify(data).includes('secret-admin'), false);
  assert.deepEqual(normalizeHistory(history('cpuPercent'), 'cpuPercent', VM, PROJECT_A), [
    { timestamp: 1791446500000, value: null }, { timestamp: 1791446560000, value: 31.4 },
  ]);
  assert.throws(() => normalizeSnapshot(snapshot(PROJECT_B), VM, PROJECT_A), (error) => error.code === 'monitoring_identity_mismatch');
  assert.throws(() => normalizeSnapshot({ ...snapshot(), metadata: { instance_id: 'foreign', project_id: PROJECT_A } }, VM, PROJECT_A),
    (error) => error.code === 'monitoring_identity_mismatch');
  assert.throws(() => normalizeHistory({ ...history('cpuPercent'), unit: 'B/s' }, 'cpuPercent', VM, PROJECT_A),
    (error) => error.code === 'monitoring_invalid_response');
  assert.throws(() => normalizeHistory({ ...history('cpuPercent'), metadata: { instance_id: VM, project_id: PROJECT_B } },
    'cpuPercent', VM, PROJECT_A), (error) => error.code === 'monitoring_identity_mismatch');
});

test('service maps 1h/6h/24h history, bounds concurrency, and leaves 7d unsupported without inventing points', async () => {
  const calls = [];
  let active = 0;
  let maximum = 0;
  const service = new MonitoringService({
    snapshot: async () => snapshot(),
    history: async (_id, key, options) => {
      active++; maximum = Math.max(maximum, active);
      calls.push({ key, options });
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return history(key);
    },
  });
  for (const [range, hours] of [['1h', 1], ['6h', 6], ['24h', 24]]) {
    calls.length = 0;
    const data = await service.metrics(VM, PROJECT_A, range, 'req');
    assert.equal(data.series.cpuPercent[0].value, null);
    assert.equal(data.series.cpuPercent[1].value, 31.4);
    assert.equal(calls.length, 6);
    assert.ok(calls.every((call) => call.options.hours === hours));
    assert.ok(calls.every((call) => call.options.stepSeconds === (range === '24h' ? 120 : 60)));
  }
  assert.ok(maximum <= 2);
  calls.length = 0;
  const week = await service.metrics(VM, PROJECT_A, '7d', 'req');
  assert.equal(week.historyUnsupported, true);
  assert.ok(Object.values(week.series).every((points) => points.length === 0));
  assert.equal(calls.length, 0);
});

test('missing snapshot and partial history retain safe N/A/No Data semantics', async () => {
  const missing = new MonitoringService({ snapshot: async () => null, history: async () => { throw new Error('should not load'); } });
  assert.deepEqual(await missing.metrics(VM, PROJECT_A, '1h', 'req'), emptyMonitoringData());
  assert.equal((await missing.metrics(VM, PROJECT_A, '7d', 'req')).historyUnsupported, true);
  const partial = new MonitoringService({ snapshot: async () => snapshot(),
    history: async (_id, key) => key === 'cpuPercent' ? history(key, 0) : { ...history(key), points: [] } });
  const data = await partial.metrics(VM, PROJECT_A, '1h', 'req');
  assert.equal(data.series.cpuPercent[1].value, 0);
  assert.ok(Object.values(data.series).slice(1).every((points) => points.length === 0));
  const oneFailure = new MonitoringService({ snapshot: async () => snapshot(),
    history: async (_id, key) => { if (key === 'memoryPercent') throw new Error('temporary history failure'); return history(key); } });
  const degraded = await oneFailure.metrics(VM, PROJECT_A, '1h', 'req');
  assert.equal(degraded.partial, true);
  assert.equal(degraded.series.memoryPercent.length, 0);
  assert.equal(degraded.series.cpuPercent.length, 2);
});

test('Monitoring timeout, outage, malformed body, and oversized body become safe errors', async () => {
  const make = (fetchImpl, timeoutMs = 100) => new MonitoringClient({ baseUrl: 'http://monitoring', timeoutMs, apiKey: API_KEY, fetchImpl });
  await assert.rejects(() => make(async () => { throw new Error('sensitive network detail'); }).snapshot(VM),
    (error) => error.code === 'monitoring_unavailable' && !error.message.includes('sensitive'));
  await assert.rejects(() => make((_url, { signal }) => new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))), 5).snapshot(VM),
  (error) => error.code === 'monitoring_timeout');
  await assert.rejects(() => make(async () => new Response('{bad')).snapshot(VM),
    (error) => error.code === 'monitoring_invalid_response');
  await assert.rejects(() => make(async () => new Response('{}', { headers: { 'content-length': '2000000' } })).snapshot(VM),
    (error) => error.code === 'monitoring_invalid_response');
  assert.equal(await make(async () => response({ detail: 'not exported' }, 404)).snapshot(VM), null);
  await assert.rejects(() => make(async () => response({ detail: 'multiple hosts' }, 409)).snapshot(VM),
    (error) => error.code === 'monitoring_ambiguous_instance' && !error.message.includes('multiple hosts'));
});

test('route authorizes current-project VM before Monitoring call and returns only allowlisted data', async () => {
  let calls = 0;
  const monitoringService = { metrics: async (_id, projectId, range) => {
    calls++;
    assert.equal(projectId, PROJECT_A);
    assert.equal(range, '1h');
    return normalizeSnapshot(snapshot(), VM, PROJECT_A);
  } };
  await withRouter({ session: { project: { id: PROJECT_A }, roles: ['member'] }, monitoringService }, async (url) => {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.summary.cpuPercent, 0);
    assert.equal(JSON.stringify(body).includes(API_KEY), false);
    assert.equal(JSON.stringify(body).includes('secret-host'), false);
  });
  assert.equal(calls, 1);
});

test('foreign-project and admin cross-project requests never call Monitoring', async () => {
  let calls = 0;
  const monitoringService = { metrics: async () => { calls++; return {}; } };
  for (const roles of [['member'], ['admin']]) {
    await withRouter({ session: { project: { id: PROJECT_A }, roles }, ownerProject: PROJECT_B, monitoringService }, async (url) => {
      const res = await fetch(url);
      assert.equal(res.status, 404);
    });
  }
  assert.equal(calls, 0);
});

test('project switch revalidates current Nova ownership and never reuses earlier-project metrics', async () => {
  let current = { token: 'token-a', project: { id: PROJECT_A }, roles: ['admin'] };
  let calls = 0;
  const app = express();
  app.use((req, _res, next) => { req.id = 'test-request'; req.session = { os: current }; next(); });
  app.use('/api', requireAuth, createVmMonitoringRouter({
    monitoringConfig: normalizeMonitoringConfig({ enabled: true, base_url: 'http://monitoring.internal' }),
    fetchOwnedInstance: async (session) => {
      assert.equal(session.token, current.token);
      return assertOwned({ id: VM, project_id: PROJECT_A }, session);
    },
    monitoringService: { metrics: async () => { calls++; return normalizeSnapshot(snapshot(), VM, PROJECT_A); } },
  }));
  app.use(errorHandler);
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/servers/${VM}/monitoring?range=1h`;
    assert.equal((await fetch(url)).status, 200);
    current = { token: 'token-b', project: { id: PROJECT_B }, roles: ['admin'] };
    assert.equal((await fetch(url)).status, 404);
    assert.equal(calls, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('missing backend key leaves feature visible but reports unavailability after ownership validation', async () => {
  const cfg = normalizeMonitoringConfig({ enabled: true, base_url: 'http://monitoring.internal' });
  assert.equal(createMonitoringService(cfg, { apiKey: '' }), null);
  await withRouter({ session: { project: { id: PROJECT_A } }, monitoringConfig: cfg, monitoringService: null }, async (url) => {
    const res = await fetch(url);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'monitoring_unavailable');
  });
});

test('invalid UUID, arbitrary project_id/PromQL, missing session, and feature-off fail before admin call', async () => {
  let ownershipChecks = 0;
  let calls = 0;
  const monitoringService = { metrics: async () => { calls++; return {}; } };
  const fetchOwnedInstance = async () => { ownershipChecks++; return { id: VM }; };
  const session = { project: { id: PROJECT_A } };
  await withRouter({ session, monitoringService, fetchOwnedInstance }, async (url) => {
    const base = url.replace(VM, 'not-a-uuid');
    assert.equal((await fetch(base)).status, 400);
    assert.equal((await fetch(`${url}?project_id=${PROJECT_B}`)).status, 400);
    assert.equal((await fetch(`${url}?query=up`)).status, 400);
    assert.equal((await fetch(`${url}?range=8h`)).status, 400);
  });
  await withRouter({ monitoringService, fetchOwnedInstance }, async (url) => {
    assert.equal((await fetch(url)).status, 401);
  });
  await withRouter({ session, monitoringService, fetchOwnedInstance,
    monitoringConfig: normalizeMonitoringConfig({ enabled: false }) }, async (url) => {
    assert.equal((await fetch(url)).status, 503);
  });
  assert.equal(ownershipChecks, 0);
  assert.equal(calls, 0);
});
