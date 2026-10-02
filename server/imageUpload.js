import { Readable } from 'node:stream';
import { config } from './config.js';
import { OSError, osFetch } from './openstack.js';

const IMAGE_POLL_ATTEMPTS = 8;
const IMAGE_POLL_DELAY_MS = 500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pathFor = (id) => `/v2/images/${encodeURIComponent(id)}`;

export function imageDiskFormat(filename) {
  if (typeof filename !== 'string' || !filename || filename.length > 255
    || /[/\\\x00-\x1f\x7f]/.test(filename)) return null;
  const extension = filename.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  return extension === 'qcow2' || extension === 'iso' ? extension : null;
}

export function decodeUploadHeader(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new OSError(400, 'Invalid image upload metadata.', 'image_upload_invalid_metadata');
  try { return decodeURIComponent(value); }
  catch { throw new OSError(400, 'Invalid image upload metadata.', 'image_upload_invalid_metadata'); }
}

function optionalMinimum(value) {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new OSError(400, 'Invalid minimum image requirements.', 'image_upload_invalid_metadata');
  }
  return number;
}

export async function uploadImage(session, { filename, name, minDisk, minRam, source, contentLength }, {
  request = osFetch, pause = wait, pollAttempts = IMAGE_POLL_ATTEMPTS, onStage = () => {},
} = {}) {
  const diskFormat = imageDiskFormat(filename);
  if (!diskFormat) throw new OSError(400, 'Only QCOW2 and ISO image files are supported.', 'image_unsupported_format');
  const imageName = String(name || '').trim();
  if (!imageName || imageName.length > 255 || /[\x00-\x1f\x7f]/.test(imageName)) {
    throw new OSError(400, 'Invalid image name.', 'image_upload_invalid_metadata');
  }
  const disk = optionalMinimum(minDisk);
  const ram = optionalMinimum(minRam);
  if (contentLength !== undefined && (!/^\d+$/.test(String(contentLength)) || Number(contentLength) < 1)) {
    throw new OSError(400, 'Image file is empty or has an invalid length.', 'image_upload_invalid_metadata');
  }
  onStage('RECEIVE_FILE', { name: imageName, filename, diskFormat, contentLength });
  let image;
  try {
    onStage('CREATE_GLANCE_METADATA');
    image = await request(session, 'image', '/v2/images', { method: 'POST', body: {
      name: imageName, disk_format: diskFormat, container_format: 'bare', visibility: 'private',
      ...(disk !== undefined ? { min_disk: disk } : {}), ...(ram !== undefined ? { min_ram: ram } : {}),
    } });
  } catch (error) {
    onStage('CREATE_GLANCE_METADATA_FAILED', { status: error?.status });
    throw new OSError(error?.status === 403 ? 403 : 502, 'Unable to create the Glance image.', 'image_create_failed');
  }
  if (!image?.id || image.owner && image.owner !== session.project.id) {
    throw new OSError(502, 'Glance returned invalid image metadata.', 'image_create_failed');
  }
  let bytes = 0;
  const payload = Readable.from((async function* () {
    for await (const chunk of source) { bytes += chunk.length; yield chunk; }
  })());
  const imagePath = pathFor(image.id);
  async function cleanup() {
    try {
      await request(session, 'image', imagePath, { method: 'DELETE', responseType: 'none' });
      onStage('CLEANUP_PARTIAL_IMAGE', { imageId: image.id, success: true });
    } catch (error) { onStage('CLEANUP_PARTIAL_IMAGE', { imageId: image.id, success: false, status: error?.status }); }
  }
  try {
    onStage('UPLOAD_GLANCE_DATA', { imageId: image.id });
    await request(session, 'image', `${imagePath}/file`, { method: 'PUT', rawBody: payload,
      headers: contentLength ? { 'Content-Length': String(contentLength) } : {},
      responseType: 'none', timeoutMs: config.providerUploadTimeoutMs });
    if (bytes === 0) throw new OSError(400, 'Image file is empty.', 'image_upload_invalid_metadata');
  } catch (error) {
    onStage('UPLOAD_GLANCE_DATA_FAILED', { imageId: image.id, status: error?.status });
    await cleanup();
    throw new OSError(error?.status === 504 ? 504 : 502, 'Unable to upload image data to OpenStack.', 'image_upload_failed');
  }
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    let current;
    try {
      onStage('VERIFY_GLANCE_IMAGE', { imageId: image.id });
      current = await request(session, 'image', imagePath);
    } catch (error) {
      onStage('VERIFY_GLANCE_IMAGE_PENDING', { imageId: image.id, status: error?.status });
      return { image: { id: image.id, status: 'processing' }, processing: true };
    }
    if (current?.owner !== session.project.id) {
      throw new OSError(502, 'Glance image ownership changed during upload.', 'image_upload_failed');
    }
    if (current.status === 'active') {
      onStage('ACTIVE', { imageId: image.id, bytes });
      return { image: current, processing: false };
    }
    if (['killed', 'deleted', 'pending_delete'].includes(current.status)) {
      await cleanup();
      throw new OSError(502, 'Glance rejected the image.', 'image_upload_failed');
    }
    if (attempt < pollAttempts - 1) await pause(IMAGE_POLL_DELAY_MS);
  }
  onStage('PROCESSING', { imageId: image.id, bytes });
  return { image: { id: image.id, status: 'processing' }, processing: true };
}
