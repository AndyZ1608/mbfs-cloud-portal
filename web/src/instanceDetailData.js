export function networkRows(ports = [], networks = [], floatingIps = [], groups = []) {
  const netById = new Map(networks.map((item) => [item.id, item]));
  const subnetById = new Map(networks.flatMap((item) => item.subnet_details || []).map((item) => [item.id, item]));
  const fipsByPort = new Map();
  for (const fip of floatingIps) {
    if (fip.port_id) fipsByPort.set(fip.port_id, [...(fipsByPort.get(fip.port_id) || []), fip]);
  }
  const groupById = new Map(groups.map((item) => [item.id, item]));
  return ports.map((port) => ({
    ...port,
    networkName: netById.get(port.network_id)?.name || port.network_id || '—',
    fixed: (port.fixed_ips || []).map((fixed) => ({
      address: fixed.ip_address,
      subnet: subnetById.get(fixed.subnet_id)?.cidr || fixed.subnet_id || '—',
    })),
    floating: (fipsByPort.get(port.id) || []).map((item) => item.floating_ip_address),
    groups: (port.security_groups || []).map((id) => groupById.get(id)).filter(Boolean),
  }));
}

export function attachedStorage(attachments = [], volumes = [], snapshots = [], serverId = null) {
  const ownedVolumes = new Map(volumes.map((volume) => [volume.id, volume]));
  const attached = attachments.flatMap((attachment) => {
    const id = attachment.volumeId || attachment.id;
    const volume = ownedVolumes.get(id);
    return volume ? [{ ...volume, device: attachment.device
      || volume.attachments?.find((item) => item.server_id === serverId)?.device || null }] : [];
  });
  const ids = new Set(attached.map((volume) => volume.id));
  return { attached, snapshots: snapshots.filter((snapshot) => ids.has(snapshot.volume_id)) };
}

export function attachedSecurityGroups(ports = [], groups = [], serverGroups = []) {
  const ids = new Set(ports.flatMap((port) => port.security_groups || []));
  const names = new Set(serverGroups.map((group) => group.name));
  return groups.filter((group) => ids.size ? ids.has(group.id) : names.has(group.name));
}

// With boot-from-volume, do not offer detachment of a volume that might be the root disk.
export function canDetachVolume(server, volume) {
  return Boolean(server.image?.id) || volume.bootable === false || volume.bootable === 'false';
}
