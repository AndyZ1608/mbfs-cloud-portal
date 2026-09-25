const FRIENDLY_DISTROS = {
  ubuntu: 'Ubuntu', windows: 'Windows', debian: 'Debian', rocky: 'Rocky Linux',
  almalinux: 'AlmaLinux', rhel: 'Red Hat Enterprise Linux', centos: 'CentOS',
  sles: 'SUSE Linux Enterprise', suse: 'SUSE', freebsd: 'FreeBSD',
};
const COMMON_ORDER = Object.keys(FRIENDLY_DISTROS);
export const OTHER_DISTRO = '__other__';

const metadata = (image, key) => image?.[key] ?? image?.properties?.[key];

export function distroKey(image) {
  const value = metadata(image, 'os_distro');
  return typeof value === 'string' && value.trim() ? value.trim().toLocaleLowerCase('en-US') : OTHER_DISTRO;
}

export function distroLabel(key, otherLabel) {
  if (key === OTHER_DISTRO) return otherLabel;
  return FRIENDLY_DISTROS[key] || key.replace(/[_-]+/g, ' ').replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase('en-US'));
}

export function imageMetadata(image, key) {
  const value = metadata(image, key);
  return value === null || value === undefined || value === '' ? null : String(value);
}

export function catalogGroups(images, search = '', otherLabel = 'Other') {
  const query = search.trim().toLocaleLowerCase('en-US');
  const groups = new Map();
  for (const image of images || []) {
    if (image?.status !== 'active' || !image.id) continue;
    const key = distroKey(image);
    const searchable = [image.name, distroLabel(key, otherLabel), key, imageMetadata(image, 'os_version')]
      .filter(Boolean).join(' ').toLocaleLowerCase('en-US');
    if (query && !searchable.includes(query)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(image);
  }
  return [...groups].map(([key, items]) => ({
    key,
    images: items.sort((a, b) => {
      const versionA = imageMetadata(a, 'os_version') || '';
      const versionB = imageMetadata(b, 'os_version') || '';
      if (!versionA && versionB) return 1;
      if (versionA && !versionB) return -1;
      return versionB.localeCompare(versionA, undefined, { numeric: true })
        || (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id);
    }),
  })).sort((a, b) => {
    if (a.key === OTHER_DISTRO) return 1;
    if (b.key === OTHER_DISTRO) return -1;
    const aIndex = COMMON_ORDER.indexOf(a.key);
    const bIndex = COMMON_ORDER.indexOf(b.key);
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.key.localeCompare(b.key);
  });
}
