import { emptyVmMonitoring } from './model.js';

// TODO: Replace this no-data boundary only after a tenant-safe Monitoring API
// exposes metrics by Nova instance UUID and validates the current project.
export async function loadVmMonitoring(_scope) {
  return emptyVmMonitoring();
}
