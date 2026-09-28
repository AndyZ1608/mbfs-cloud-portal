// UI consumes CMP's fixed allowlist only. Never render provider fault text or
// use an unknown code as a translation key or a visible diagnostic.
import { bootVolumeSizeWarning, minimumBootVolumeGiB } from '../../shared/imageSize.mjs';

export { minimumBootVolumeGiB };

export const INSTANCE_ERROR_CODES = new Set([
  'NO_VALID_HOST', 'FLAVOR_DISK_TOO_SMALL', 'FLAVOR_RAM_TOO_SMALL',
  'QUOTA_EXCEEDED', 'IMAGE_UNAVAILABLE', 'IMAGE_INVALID',
  'PORT_BINDING_FAILED', 'IP_ALLOCATION_FAILED', 'NETWORK_UNAVAILABLE',
  'VOLUME_CREATE_FAILED', 'VOLUME_ATTACH_FAILED', 'BLOCK_DEVICE_MAPPING_FAILED', 'IMAGE_SIZE_EXCEEDS_VOLUME',
  'AVAILABILITY_ZONE_UNAVAILABLE', 'BUILD_FAILED', 'UNKNOWN_INSTANCE_ERROR',
]);

export function safeInstanceErrorCode(code) {
  return INSTANCE_ERROR_CODES.has(code) ? code : 'UNKNOWN_INSTANCE_ERROR';
}

export function instanceErrorTitle(t, code) {
  return t(`instance.error.code.${safeInstanceErrorCode(code)}`);
}

export function instanceErrorCategory(code) {
  const safeCode = safeInstanceErrorCode(code);
  return safeCode === 'NO_VALID_HOST' || safeCode === 'AVAILABILITY_ZONE_UNAVAILABLE' ? 'scheduling'
    : safeCode === 'IMAGE_SIZE_EXCEEDS_VOLUME' ? 'storage'
    : safeCode === 'FLAVOR_DISK_TOO_SMALL' || safeCode === 'FLAVOR_RAM_TOO_SMALL' || safeCode.startsWith('IMAGE_') ? 'image'
      : safeCode === 'QUOTA_EXCEEDED' ? 'quota'
        : ['PORT_BINDING_FAILED', 'IP_ALLOCATION_FAILED', 'NETWORK_UNAVAILABLE'].includes(safeCode) ? 'network'
          : ['VOLUME_CREATE_FAILED', 'VOLUME_ATTACH_FAILED', 'BLOCK_DEVICE_MAPPING_FAILED'].includes(safeCode) ? 'storage'
            : safeCode === 'BUILD_FAILED' ? 'build'
            : 'unknown';
}

export function safeVolumeContext(context) {
  const required = context?.required_disk_gb;
  const requested = context?.requested_volume_gb;
  return Number.isSafeInteger(required) && required > 0 && Number.isSafeInteger(requested) && requested > 0
    && required > requested ? { required_disk_gb: required, requested_volume_gb: requested } : null;
}

export function instanceErrorDescription(t, error) {
  const context = error?.code === 'IMAGE_SIZE_EXCEEDS_VOLUME' ? safeVolumeContext(error.context) : null;
  return context ? t('instance.error.description.imageSizeExceedsVolume', context)
    : t(`instance.error.description.${instanceErrorCategory(error?.code)}`);
}

export function instanceErrorGuidance(t, code, context) {
  const sizes = code === 'IMAGE_SIZE_EXCEEDS_VOLUME' ? safeVolumeContext(context) : null;
  if (sizes) return t('instance.error.guidance.imageSizeExceedsVolume', sizes);
  return t(`instance.error.guidance.${instanceErrorCategory(code)}`);
}

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

// Advisory, immediate form feedback. The backend independently validates the
// authoritative Glance image and Nova flavor before submitting a create.
export function imageFlavorWarning(image, flavor, bootFromVolume = false, bootVolumeGiB = null) {
  const requiredRam = positive(image?.min_ram);
  const flavorRam = positive(flavor?.ram);
  if (requiredRam && flavorRam && requiredRam > flavorRam) {
    return { code: 'FLAVOR_RAM_TOO_SMALL', context: { required_ram_mb: requiredRam, flavor_ram_mb: flavorRam } };
  }
  if (bootFromVolume) return bootVolumeSizeWarning(image, bootVolumeGiB);
  const requiredDisk = positive(image?.min_disk);
  const flavorDisk = positive(flavor?.disk);
  if (!bootFromVolume && requiredDisk && flavorDisk && requiredDisk > flavorDisk) {
    return { code: 'FLAVOR_DISK_TOO_SMALL', context: { required_disk_gb: requiredDisk, flavor_disk_gb: flavorDisk } };
  }
  return null;
}

export function imageFlavorWarningText(t, warning) {
  if (!warning) return '';
  if (warning.code === 'FLAVOR_RAM_TOO_SMALL') return t('instance.error.preflight.ram', warning.context);
  if (warning.code === 'FLAVOR_DISK_TOO_SMALL') return t('instance.error.preflight.disk', warning.context);
  if (warning.code === 'IMAGE_SIZE_EXCEEDS_VOLUME') return t('instance.error.preflight.bootVolume', warning.context);
  return '';
}
