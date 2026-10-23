import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { allocationPercentage } from '../src/clusterCapacity.js';

test('allocation percentage uses allocatable capacity and does not clamp true over-allocation', () => {
  assert.equal(allocationPercentage(292, 1024), 28.515625);
  assert.equal(allocationPercentage(292, 256), 114.0625);
  assert.equal(allocationPercentage(0, 1024), 0);
  assert.equal(allocationPercentage(0, 0), null);
});

test('cluster overview renders Placement vCPU without changing Nova RAM/disk or hiding them on Placement failure', async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const priorStorage = globalThis.localStorage;
  try {
    const { ClusterOverview } = await vite.ssrLoadModule('/src/pages/Admin.jsx');
    const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n/react.jsx');
    const data = {
      hypervisors: { count: 1, vcpus: 256, vcpus_used: 292, memory_mb: 3096064, memory_mb_used: 704000, local_gb: 196, local_gb_used: 0, running_vms: 34 },
      projects: Array.from({ length: 8 }, (_, index) => ({ id: String(index) })),
      vcpu: { allocated: 292, allocatable: 1024, inventory_total: 256, provider_count: 1, allocation_ratio: 4 },
    };
    function render(locale, value) {
      globalThis.localStorage = { getItem: (key) => key === 'cmp.locale' ? locale : null };
      return renderToStaticMarkup(React.createElement(LocaleProvider, null,
        React.createElement(ClusterOverview, { data: value })));
    }
    const en = render('en', data);
    assert.match(en, /292\s*\/\s*1,024/);
    assert.match(en, /28\.5%/);
    assert.doesNotMatch(en, /114%/);
    assert.match(en, /0\s*\/\s*196 GB/);
    assert.match(en, /34/);
    assert.match(en, /Projects/);
    assert.match(en, /VCPU inventory total: 256/);
    const vi = render('vi', data);
    assert.match(vi, /292\s*\/\s*1\.024/);
    assert.match(vi, /28,5%/);
    const failed = render('en', { ...data, vcpu: null, vcpu_error: 'placement_unavailable' });
    assert.match(failed, /Placement vCPU capacity is unavailable/);
    assert.doesNotMatch(failed, /292\s*\/\s*256/);
    assert.match(failed, /0\s*\/\s*196 GB/);
    const over = render('en', { ...data, vcpu: { ...data.vcpu, allocatable: 256 } });
    assert.match(over, /114\.1%/);
    assert.match(over, /fill-err/);
    assert.match(over, /VCPU allocations exceed Placement capacity/);
    const zeroCapacity = render('en', { ...data, vcpu: { ...data.vcpu, allocatable: 0 } });
    assert.match(zeroCapacity, /VCPU allocations exceed Placement capacity/);
    assert.match(zeroCapacity, /fill-err/);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    await vite.close();
  }
});
