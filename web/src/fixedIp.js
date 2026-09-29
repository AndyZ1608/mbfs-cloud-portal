// Presentation-side validation. The backend remains authoritative before Neutron port creation.
function ipv4Parts(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)
    || String(Number(part)) !== part || Number(part) > 255)) return null;
  return parts.map(Number);
}

function ipv4Number(parts) {
  return parts.reduce((number, part) => (number << 8n) + BigInt(part), 0n);
}

function ipv6Number(value) {
  if (typeof value !== 'string' || !value.includes(':')) return null;
  let address = value.toLowerCase();
  if (address.includes('.')) {
    const tail = address.slice(address.lastIndexOf(':') + 1);
    const parts = ipv4Parts(tail);
    if (!parts) return null;
    const number = ipv4Number(parts);
    address = `${address.slice(0, address.lastIndexOf(':') + 1)}${(number >> 16n).toString(16)}:${(number & 65535n).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(address) || (address.match(/::/g) || []).length > 1) return null;
  const compressed = address.includes('::');
  const [left, right] = address.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const count = before.length + after.length;
  if (count > 8 || (compressed ? count >= 8 : count !== 8)
    || [...before, ...after].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const groups = compressed ? [...before, ...Array(8 - count).fill('0'), ...after] : before;
  return groups.reduce((number, part) => (number << 16n) + BigInt(parseInt(part, 16)), 0n);
}

export function subnetAddressInfo(cidr) {
  if (typeof cidr !== 'string') return null;
  const match = cidr.match(/^([^/]+)\/(\d{1,3})$/);
  if (!match) return null;
  const baseParts = ipv4Parts(match[1]);
  const version = baseParts ? 4 : ipv6Number(match[1]) !== null ? 6 : 0;
  const bits = Number(match[2]);
  const width = version === 4 ? 32 : 128;
  if (!version || bits > width) return null;
  const base = version === 4 ? ipv4Number(baseParts) : ipv6Number(match[1]);
  const hostBits = BigInt(width - bits);
  const network = (base >> hostBits) << hostBits;
  const broadcast = network + (1n << hostBits) - 1n;
  const fixedOctets = version === 4 && [8, 16, 24].includes(bits) ? bits / 8 : 0;
  const networkParts = version === 4 ? [24n, 16n, 8n, 0n].map((shift) => Number((network >> shift) & 255n)) : null;
  return { version, bits, network, broadcast, hostBits, fixedOctets,
    fixedParts: fixedOctets ? networkParts.slice(0, fixedOctets).map(String) : [], cidr };
}

export function segmentedHostOctets(info, value) {
  if (!info?.fixedOctets) return null;
  if (!value) return Array(4 - info.fixedOctets).fill('');
  const parts = value.split('.');
  if (parts.length !== 4 || !info.fixedParts.every((part, index) => parts[index] === part)) return null;
  return parts.slice(info.fixedOctets);
}

export function composeSegmentedIp(info, hostOctets) {
  if (!info?.fixedOctets || hostOctets.length !== 4 - info.fixedOctets) return '';
  if (hostOctets.every((part) => part === '')) return '';
  return [...info.fixedParts, ...hostOctets].join('.');
}

export function fixedIpError(value, subnet) {
  if (!value) return null;
  const info = subnetAddressInfo(subnet?.cidr);
  if (!info) return 'invalidIp';
  if (info.version === 4) {
    if (value.split('.').length === 4 && value.split('.').some((part) => part === '')) return 'incompleteIp';
    const parts = ipv4Parts(value);
    if (!parts) return 'invalidIp';
    const address = ipv4Number(parts);
    if (address < info.network || address > info.broadcast) return 'ipOutsideSubnet';
    if (info.bits <= 30 && address === info.network) return 'networkAddressNotAllowed';
    if (info.bits <= 30 && address === info.broadcast) return 'broadcastAddressNotAllowed';
  } else {
    const address = ipv6Number(value);
    if (address === null) return 'invalidIp';
    if (address < info.network || address > info.broadcast) return 'ipOutsideSubnet';
  }
  if (value === subnet.gateway_ip) return 'gatewayAddressNotAllowed';
  return null;
}
