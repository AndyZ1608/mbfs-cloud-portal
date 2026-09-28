// Glance virtual_size is bytes; Cinder boot volume size is an integer GiB.
// Use integer arithmetic so even one byte over a GiB boundary rounds up.
const GIB_BYTES = 1024n ** 3n;

function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nonNegativeBytes(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^\d{1,40}$/.test(value)) return BigInt(value);
  return null;
}

export function minimumBootVolumeGiB(image) {
  const minDisk = nonNegativeInteger(image?.min_disk);
  const bytes = nonNegativeBytes(image?.virtual_size);
  const virtualGiB = bytes === null ? null : Number((bytes + GIB_BYTES - 1n) / GIB_BYTES);
  const validVirtualGiB = Number.isSafeInteger(virtualGiB) ? virtualGiB : null;
  const required = Math.max(minDisk ?? 0, validVirtualGiB ?? 0);
  return required > 0 ? required : null;
}

export function bootVolumeSizeWarning(image, requestedGiB) {
  const required = minimumBootVolumeGiB(image);
  const requested = nonNegativeInteger(requestedGiB);
  if (!required || requested === null || requested <= 0 || requested >= required) return null;
  return { code: 'IMAGE_SIZE_EXCEEDS_VOLUME',
    context: { required_disk_gb: required, requested_volume_gb: requested } };
}
