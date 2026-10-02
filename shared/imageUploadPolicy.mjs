// Binary GiB policy shared by the CMP browser pre-check and backend authority.
export const MAX_IMAGE_UPLOAD_BYTES = 15 * 1024 * 1024 * 1024;
export const imageUploadSizeAllowed = (bytes) => Number.isSafeInteger(bytes)
  && bytes > 0 && bytes < MAX_IMAGE_UPLOAD_BYTES;
