import { api } from '../api.js';
import { MONITORING_RANGES } from './model.js';

export async function loadVmMonitoring({ instanceId, range, signal }) {
  if (!MONITORING_RANGES.includes(range)) throw new Error('Invalid Monitoring range');
  return api(`/servers/${encodeURIComponent(instanceId)}/monitoring?range=${encodeURIComponent(range)}`, { signal });
}
