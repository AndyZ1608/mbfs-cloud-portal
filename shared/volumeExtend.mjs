export const canExtendVolume = (status) => status === 'available' || status === 'in-use';

export const validVolumeExtendSize = (currentSize, newSize) => Number.isSafeInteger(currentSize)
  && Number.isSafeInteger(newSize) && currentSize > 0 && newSize > currentSize;
