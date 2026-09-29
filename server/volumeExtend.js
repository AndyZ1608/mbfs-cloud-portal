import { endpointFor, MOCK, OSError, osFetch, providerFetch } from './openstack.js';
import { canExtendVolume, validVolumeExtendSize } from '../shared/volumeExtend.mjs';

export const ONLINE_EXTEND_MICROVERSION = '3.42';

export function cinderVersionDiscoveryUrl(catalog) {
  const endpoint = new URL(endpointFor(catalog, 'volume'));
  const versionPath = endpoint.pathname.match(/^(.*\/v3(?:\.0)?)(?:\/[^/]*)?\/?$/);
  if (!versionPath) throw new OSError(409, 'Cinder v3 is required for online volume extension.', 'volume_online_extend_version_unsupported');
  endpoint.pathname = `${versionPath[1]}/`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

const minorVersion = (value) => /^3\.\d+$/.test(value) ? Number(value.slice(2)) : null;

export async function ensureOnlineExtendVersion(session, { request = providerFetch } = {}) {
  const response = await request(cinderVersionDiscoveryUrl(session.catalog), {
    headers: { 'X-Auth-Token': session.token, Accept: 'application/json' },
  });
  if (!response.ok) throw new OSError(502, 'Unable to verify the Cinder API version.', 'volume_api_version_unavailable');
  let data;
  try { data = await response.json(); }
  catch { throw new OSError(502, 'Cinder returned invalid API version information.', 'volume_api_version_unavailable'); }
  const version = data?.version || (Array.isArray(data?.versions)
    ? data.versions.find((item) => String(item.id || '').startsWith('v3')) : null);
  const minimum = minorVersion(version?.min_version);
  const maximum = minorVersion(version?.version);
  if (minimum === null || maximum === null) {
    throw new OSError(502, 'Cinder did not advertise a valid v3 microversion range.', 'volume_api_version_unavailable');
  }
  if (maximum < 42 || minimum > maximum) {
    throw new OSError(409, 'Cinder does not support online volume extension at microversion 3.42.', 'volume_online_extend_version_unsupported');
  }
  return `3.${Math.max(42, minimum)}`;
}

export function volumeExtendError(error, attached) {
  if (!attached) return error;
  if (error?.status === 403) return new OSError(403, 'Online extension is not permitted by cloud policy.', 'volume_online_extend_forbidden');
  if ([400, 409].includes(error?.status)) {
    const unsupported = /(?:not support|unsupported|extend_attached_volume|driver.*extend)/i.test(error.message || '');
    return new OSError(409, unsupported
      ? 'The storage backend does not support extending this attached volume.'
      : 'Cinder rejected online extension of this attached volume.',
    unsupported ? 'volume_online_extend_unsupported' : 'volume_online_extend_rejected');
  }
  return error;
}

export async function requestVolumeExtend(session, volume, newSize,
  { request = osFetch, verifyVersion = ensureOnlineExtendVersion, mock = MOCK } = {}) {
  if (!canExtendVolume(volume?.status)) {
    throw new OSError(409, 'Volume status does not permit extension.', 'volume_extend_state_invalid');
  }
  if (!validVolumeExtendSize(volume.size, newSize)) {
    throw new OSError(400, 'New volume size must be a larger integer GiB value.', 'volume_extend_size_invalid');
  }
  const attached = volume.status === 'in-use';
  const microversion = attached ? mock ? ONLINE_EXTEND_MICROVERSION : await verifyVersion(session) : null;
  try {
    await request(session, 'volume', `/volumes/${encodeURIComponent(volume.id)}/action`, {
      method: 'POST', body: { 'os-extend': { new_size: newSize } }, responseType: 'none',
      ...(attached ? { headers: { 'OpenStack-API-Version': `volume ${microversion}` } } : {}),
    });
  } catch (error) { throw volumeExtendError(error, attached); }
  return { success: true, accepted: true };
}
