import test from 'node:test';
import assert from 'node:assert/strict';
import { config, normalizeMonitoringConfig } from '../config.js';

test('Monitoring capability is independent of external metric availability', () => {
  assert.deepEqual(normalizeMonitoringConfig({ enabled: true }), { enabled: true });
  assert.deepEqual(normalizeMonitoringConfig({ enabled: false }), { enabled: false });
  assert.deepEqual(normalizeMonitoringConfig({}), { enabled: false });
  assert.equal(config.monitoring.enabled, true);
});

test('public capability exposes only Monitoring enabled state, not infrastructure details', async () => {
  const express = (await import('express')).default;
  const { default: authRoutes } = await import('../routes/auth.js');
  const app = express();
  app.use('/api/auth', authRoutes);
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.monitoringEnabled, true);
    assert.equal(Object.keys(body).some((key) => /monitoring.*(?:url|key|secret)/i.test(key)), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
