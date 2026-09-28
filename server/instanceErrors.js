// Nova faults are untrusted provider diagnostics. Only fixed CMP codes and validated
// scalar context leave this module; fault.message/details are never copied to clients.
const CATEGORIES = Object.freeze({
  NO_VALID_HOST: 'scheduling',
  FLAVOR_DISK_TOO_SMALL: 'image',
  FLAVOR_RAM_TOO_SMALL: 'image',
  QUOTA_EXCEEDED: 'quota',
  IMAGE_UNAVAILABLE: 'image',
  IMAGE_INVALID: 'image',
  PORT_BINDING_FAILED: 'network',
  IP_ALLOCATION_FAILED: 'network',
  NETWORK_UNAVAILABLE: 'network',
  VOLUME_CREATE_FAILED: 'storage',
  VOLUME_ATTACH_FAILED: 'storage',
  BLOCK_DEVICE_MAPPING_FAILED: 'storage',
  AVAILABILITY_ZONE_UNAVAILABLE: 'scheduling',
  BUILD_FAILED: 'build',
  UNKNOWN_INSTANCE_ERROR: 'unknown',
});

const RULES = [
  ['FLAVOR_DISK_TOO_SMALL', /\b(?:FlavorDiskTooSmall|ImageTooLarge)\b|\bflavor disk (?:is )?too small\b/i],
  ['FLAVOR_RAM_TOO_SMALL', /\b(?:FlavorMemoryTooSmall|ImageTooLargeForMemory)\b|\bflavor (?:ram|memory) (?:is )?too small\b/i],
  ['AVAILABILITY_ZONE_UNAVAILABLE', /\b(?:AvailabilityZoneNotFound|InvalidAvailabilityZone)\b/i],
  ['NO_VALID_HOST', /\bNoValidHost\b|\bno valid host (?:was )?found\b/i],
  ['QUOTA_EXCEEDED', /\b(?:OverQuota|QuotaExceeded|QuotaError)\b|\bquota (?:has been )?exceeded\b/i],
  ['PORT_BINDING_FAILED', /\b(?:PortBindingFailed|VirtualInterfacePlugException)\b|\bfailed to bind port\b/i],
  ['IP_ALLOCATION_FAILED', /\b(?:IpAddressGenerationFailure|NoMoreFixedIps|NoMoreIPs|NoAvailableIPs)\b/i],
  ['NETWORK_UNAVAILABLE', /\b(?:NetworkNotFound|NetworkUnavailable)\b/i],
  ['VOLUME_CREATE_FAILED', /\b(?:VolumeCreateFailed|VolumeNotCreated)\b/i],
  ['VOLUME_ATTACH_FAILED', /\b(?:VolumeAttachFailed|VolumeAttachmentFailed)\b/i],
  ['BLOCK_DEVICE_MAPPING_FAILED', /\b(?:InvalidBDM\w*|InvalidBlockDeviceMapping)\b/i],
  ['IMAGE_UNAVAILABLE', /\b(?:ImageNotActive|ImageNotFound|ImageUnavailable)\b/i],
  ['IMAGE_INVALID', /\b(?:ImageUnacceptable|InvalidImage)\b/i],
  ['BUILD_FAILED', /\b(?:BuildAbortException|InstanceBuildFailure)\b/i],
];

function providerText(value) { return typeof value === 'string' ? value.slice(0, 32768) : ''; }
function safeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function preflightImageFlavor(image, flavor, { bootFromVolume = false } = {}) {
  const requiredRam = positiveNumber(image?.min_ram);
  const flavorRam = positiveNumber(flavor?.ram);
  if (requiredRam && flavorRam && requiredRam > flavorRam) {
    return { code: 'FLAVOR_RAM_TOO_SMALL', category: CATEGORIES.FLAVOR_RAM_TOO_SMALL,
      context: { required_ram_mb: requiredRam, flavor_ram_mb: flavorRam } };
  }
  const requiredDisk = positiveNumber(image?.min_disk);
  const flavorDisk = positiveNumber(flavor?.disk);
  if (!bootFromVolume && requiredDisk && flavorDisk && requiredDisk > flavorDisk) {
    return { code: 'FLAVOR_DISK_TOO_SMALL', category: CATEGORIES.FLAVOR_DISK_TOO_SMALL,
      context: { required_disk_gb: requiredDisk, flavor_disk_gb: flavorDisk } };
  }
  return null;
}

export function classifyInstanceError(server) {
  if (server?.status !== 'ERROR') return null;
  const fault = server?.fault && typeof server.fault === 'object' && !Array.isArray(server.fault) ? server.fault : {};
  const structuredCode = typeof fault.code === 'string' && Object.hasOwn(CATEGORIES, fault.code) ? fault.code : null;
  const signals = [providerText(fault.exception), providerText(fault.message), providerText(fault.details)];
  const code = structuredCode || signals.map((signal) => RULES.find(([, pattern]) => pattern.test(signal))?.[0]).find(Boolean)
    || 'UNKNOWN_INSTANCE_ERROR';
  const occurred = safeDate(fault.created);
  return { code, category: CATEGORIES[code], severity: 'error', ...(occurred ? { occurred_at: occurred } : {}) };
}

export function publicServer(server) {
  if (!server || typeof server !== 'object') return server;
  const { fault: _fault, ...visible } = server;
  return visible;
}

export function publicServerPayload(data) {
  return data?.server ? { ...data, server: publicServer(data.server) } : data;
}
