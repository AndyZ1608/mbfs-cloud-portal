import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-material';

const { placementVcpuCapacity } = await import('../clusterCapacity.js');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function placementFixture(providers, { failAt } = {}) {
  const calls = [];
  const fetcher = async (_session, service, path) => {
    calls.push({ service, path });
    if (path === failAt) throw new Error('Placement unavailable');
    if (path === '/resource_providers') {
      return { resource_providers: providers.map((provider) => ({ uuid: provider.uuid })) };
    }
    const match = path.match(/^\/resource_providers\/([^/]+)\/(inventories|usages)$/);
    const provider = providers.find((item) => item.uuid === match?.[1]);
    if (!provider) throw new Error('Unknown provider');
    return match[2] === 'inventories' ? { inventories: provider.inventories } : { usages: provider.usages };
  };
  return { fetcher, calls };
}

test('Placement inventory ratio 4 and 6 produce 1024 and 1536, with usage from the same provider', async () => {
  for (const [ratio, expected] of [[4, 1024], [6, 1536]]) {
    const { fetcher } = placementFixture([{ uuid: id(1), inventories: { VCPU: { total: 256, reserved: 0, allocation_ratio: ratio } }, usages: { VCPU: 292 } }]);
    assert.deepEqual(await placementVcpuCapacity({}, fetcher), {
      allocated: 292, allocatable: expected, inventory_total: 256, provider_count: 1, allocation_ratio: ratio,
    });
  }
});

test('sums distinct VCPU providers with reserved capacity and differing ratios, excluding PCPU-only providers', async () => {
  const providers = [
    { uuid: id(1), inventories: { VCPU: { total: 16, reserved: 2, allocation_ratio: 4 }, MEMORY_MB: { total: 4096 } }, usages: { VCPU: 11 } },
    { uuid: id(2), inventories: { VCPU: { total: 8, reserved: 1, allocation_ratio: 6 } }, usages: { VCPU: 7 } },
    { uuid: id(3), inventories: { PCPU: { total: 24, allocation_ratio: 1 } }, usages: { PCPU: 20 } },
  ];
  const { fetcher, calls } = placementFixture([...providers, providers[0]]);
  assert.deepEqual(await placementVcpuCapacity({}, fetcher), {
    allocated: 18, allocatable: 98, inventory_total: 24, provider_count: 2, allocation_ratio: null,
  });
  assert.equal(calls.filter(({ path }) => path === `/resource_providers/${id(1)}/inventories`).length, 1);
  assert.equal(calls.some(({ path }) => path === `/resource_providers/${id(3)}/usages`), false);
});

test('preserves genuine over-allocation and measured zero usage', async () => {
  const { fetcher } = placementFixture([{ uuid: id(1), inventories: { VCPU: { total: 10, reserved: 0, allocation_ratio: 1 } }, usages: { VCPU: 12 } }]);
  assert.equal((await placementVcpuCapacity({}, fetcher)).allocated, 12);
  const zero = placementFixture([{ uuid: id(1), inventories: { VCPU: { total: 10 } }, usages: {} }]);
  assert.equal((await placementVcpuCapacity({}, zero.fetcher)).allocated, 0);
});

test('Placement failure and missing or invalid VCPU inventory never fall back to Nova capacity', async () => {
  const provider = { uuid: id(1), inventories: { VCPU: { total: 256, allocation_ratio: 4 } }, usages: { VCPU: 292 } };
  const failed = placementFixture([provider], { failAt: `/resource_providers/${id(1)}/usages` });
  await assert.rejects(placementVcpuCapacity({}, failed.fetcher), /Placement unavailable/);
  const missing = placementFixture([{ ...provider, inventories: { PCPU: { total: 256 } } }]);
  await assert.rejects(placementVcpuCapacity({}, missing.fetcher), /VCPU inventory unavailable/);
  const invalid = placementFixture([{ ...provider, inventories: { VCPU: { total: 10, reserved: 11, allocation_ratio: 4 } } }]);
  await assert.rejects(placementVcpuCapacity({}, invalid.fetcher), /Invalid Placement VCPU inventory/);
  const empty = placementFixture([]);
  await assert.rejects(placementVcpuCapacity({}, empty.fetcher), /VCPU inventory unavailable/);
});

test('cluster overview is admin-only and preserves Nova RAM, disk, VM and project figures', async (t) => {
  const { createApp } = await import('../app.js');
  const app = createApp({ sessionStore: null, sessionSecret: 'cluster-capacity-test' }).listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  async function cookieFor(username) {
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'X-CMP-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'demo' }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const tenantCookie = await cookieFor('tenant');
  assert.equal((await fetch(`${base}/admin/overview`)).status, 401);
  assert.equal((await fetch(`${base}/admin/overview`, { headers: { Cookie: tenantCookie } })).status, 403);
  const adminCookie = await cookieFor('admin');
  const response = await fetch(`${base}/admin/overview`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.hypervisors.memory_mb, 393216);
  assert.equal(result.hypervisors.local_gb, 6000);
  assert.equal(result.hypervisors.running_vms > 0, true);
  assert.equal(result.hypervisors.count, 3);
  assert.equal(result.projects.length, 2);
  assert.deepEqual(result.vcpu, { allocated: 41, allocatable: 384, inventory_total: 96, provider_count: 1, allocation_ratio: 4 });
});
