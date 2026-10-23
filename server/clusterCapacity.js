import { osFetch } from './openstack.js';

// An unfiltered provider list is important: resources=VCPU:1 omits providers
// with no remaining capacity, including over-allocated compute providers.
export async function placementVcpuCapacity(session, fetchOpenStack = osFetch) {
  const response = await fetchOpenStack(session, 'placement', '/resource_providers');
  if (!Array.isArray(response?.resource_providers)) throw new Error('Invalid Placement resource provider list');

  const ids = [...new Set(response.resource_providers.map((provider) => provider?.uuid))];
  if (ids.some((id) => typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id))) {
    throw new Error('Invalid Placement resource provider UUID');
  }

  let allocated = 0;
  let allocatable = 0;
  let inventoryTotal = 0;
  let providerCount = 0;
  const ratios = new Set();
  // Bound concurrent requests for larger clusters; each provider has its own
  // inventory, and only providers with VCPU inventory need a usage request.
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const uuid = ids[next++];
      const path = `/resource_providers/${encodeURIComponent(uuid)}`;
      const inventoryResponse = await fetchOpenStack(session, 'placement', `${path}/inventories`);
      if (!inventoryResponse?.inventories || typeof inventoryResponse.inventories !== 'object') {
        throw new Error('Invalid Placement inventory response');
      }
      const inventory = inventoryResponse.inventories.VCPU;
      if (!inventory) continue; // PCPU-only and non-compute providers are excluded.

      const total = inventory.total;
      const reserved = inventory.reserved ?? 0;
      const ratio = inventory.allocation_ratio ?? 1;
      if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(reserved)
        || reserved < 0 || reserved > total || !Number.isFinite(ratio) || ratio <= 0) {
        throw new Error('Invalid Placement VCPU inventory');
      }
      const usageResponse = await fetchOpenStack(session, 'placement', `${path}/usages`);
      if (!usageResponse?.usages || typeof usageResponse.usages !== 'object') {
        throw new Error('Invalid Placement usage response');
      }
      const used = usageResponse.usages.VCPU ?? 0;
      if (!Number.isSafeInteger(used) || used < 0) throw new Error('Invalid Placement VCPU usage');
      allocated += used;
      allocatable += (total - reserved) * ratio;
      inventoryTotal += total;
      providerCount++;
      ratios.add(ratio);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, () => worker()));
  if (!providerCount || !Number.isSafeInteger(allocated) || !Number.isFinite(allocatable)) {
    throw new Error('Placement VCPU inventory unavailable');
  }
  return {
    allocated,
    allocatable,
    inventory_total: inventoryTotal,
    provider_count: providerCount,
    allocation_ratio: ratios.size === 1 ? [...ratios][0] : null,
  };
}
