// Keep Neutron Port IDs as submission identity, but expose only workload names and
// subnet IPs to the assignment picker. One group represents one VM.
export function vipAssignmentVms(targets, subnetId) {
  const byInstance = new Map();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target?.id || !target?.device_id) continue;
    let vm = byInstance.get(target.device_id);
    if (!vm) {
      vm = { instanceId: target.device_id, instanceName: '', interfaces: [] };
      byInstance.set(target.device_id, vm);
    }
    if (!vm.instanceName && typeof target.instance_name === 'string') vm.instanceName = target.instance_name.trim();
    const fixedIp = (target.fixed_ips || []).filter((fixed) => fixed.subnet_id === subnetId)
      .map((fixed) => fixed.ip_address).filter(Boolean).join(', ');
    vm.interfaces.push({ portId: target.id, fixedIp, assigned: target.assigned === true,
      externalPair: target.external_pair === true });
  }
  const compare = (left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  return [...byInstance.values()].map((vm) => ({ ...vm,
    interfaces: vm.interfaces.sort((a, b) => compare(a.fixedIp, b.fixedIp)) })).sort((a, b) =>
    compare(a.instanceName, b.instanceName) || compare(a.interfaces[0]?.fixedIp || '', b.interfaces[0]?.fixedIp || ''));
}

export function filterVipAssignmentVms(vms, query) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return vms;
  return vms.filter((vm) => vm.instanceName.toLocaleLowerCase().includes(term)
    || vm.interfaces.some((item) => item.fixedIp.toLocaleLowerCase().includes(term)));
}

export function toggleVipPort(selected, portId) {
  const next = new Set(selected);
  if (next.has(portId)) next.delete(portId);
  else next.add(portId);
  return next;
}
