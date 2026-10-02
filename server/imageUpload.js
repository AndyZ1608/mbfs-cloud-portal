import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { OSError, osFetch } from './openstack.js';
import { MAX_IMAGE_UPLOAD_BYTES } from '../shared/imageUploadPolicy.mjs';

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

const tooLarge = () => new OSError(413, 'The image file exceeds the allowed size. Only images smaller than 15 GB are supported.', 'image_upload_too_large');

export function validateImageContentLength(value, limitBytes = MAX_IMAGE_UPLOAD_BYTES) {
  if (value === undefined || value === null) return null;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new OSError(400, 'Invalid image upload length.', 'image_upload_invalid_metadata');
  }
  const bytes = Number(value);
  if (bytes >= limitBytes) throw tooLarge();
  if (bytes === 0) throw new OSError(400, 'Image file is empty.', 'image_upload_invalid_metadata');
  return bytes;
}

export async function stageImageToTemp(source, { tempRoot = config.imageUploadTempDir,
  limitBytes = MAX_IMAGE_UPLOAD_BYTES } = {}) {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(tempRoot, 'cmp-image-'));
  const filePath = path.join(directory, 'payload');
  let handle;
  let bytes = 0;
  let completed = false;
  try {
    handle = await open(filePath, 'wx', 0o600);
    // Keep the HTTP request alive long enough to send 413. The route closes
    // the connection gracefully after the response; no more bytes reach disk.
    const iterator = typeof source.iterator === 'function'
      ? source.iterator({ destroyOnReturn: false }) : source[Symbol.asyncIterator]();
    for await (const chunk of iterator) {
      if (bytes + chunk.length >= limitBytes) {
        source.pause?.();
        throw tooLarge();
      }
      bytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        offset += result.bytesWritten;
      }
    }
    if (bytes === 0) throw new OSError(400, 'Image file is empty.', 'image_upload_invalid_metadata');
    completed = true;
    return { directory, filePath, bytes };
  } catch (error) {
    if (error?.code === 'image_upload_too_large') source.pause?.();
    throw error instanceof OSError ? error
      : new OSError(502, 'Unable to receive image data.', 'image_upload_receive_failed');
  } finally {
    await handle?.close();
    if (!completed) {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

export async function uploadImage(session, { filename, name, minDisk, minRam, source, contentLength }, {
  request = osFetch, pause = wait, pollAttempts = IMAGE_POLL_ATTEMPTS, onStage = () => {},
  tempRoot = config.imageUploadTempDir, maxBytes = MAX_IMAGE_UPLOAD_BYTES,
} = {}) {
  const diskFormat = imageDiskFormat(filename);
  if (!diskFormat) throw new OSError(400, 'Only QCOW2 and ISO image files are supported.', 'image_unsupported_format');
  const imageName = String(name || '').trim();
  if (!imageName || imageName.length > 255 || /[\x00-\x1f\x7f]/.test(imageName)) {
    throw new OSError(400, 'Invalid image name.', 'image_upload_invalid_metadata');
  }
  const disk = optionalMinimum(minDisk);
  const ram = optionalMinimum(minRam);
  validateImageContentLength(contentLength, maxBytes);
  onStage('RECEIVE_FILE', { name: imageName, filename, diskFormat, contentLength });
  const staged = await stageImageToTemp(source, { tempRoot, limitBytes: maxBytes });
  try {
    onStage('FILE_STAGED', { bytes: staged.bytes });
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
    const imagePath = pathFor(image.id);
    async function cleanup() {
      try {
        await request(session, 'image', imagePath, { method: 'DELETE', responseType: 'none' });
        onStage('CLEANUP_PARTIAL_IMAGE', { imageId: image.id, success: true });
      } catch (error) { onStage('CLEANUP_PARTIAL_IMAGE', { imageId: image.id, success: false, status: error?.status }); }
    }
    try {
      onStage('UPLOAD_GLANCE_DATA', { imageId: image.id });
      await request(session, 'image', `${imagePath}/file`, { method: 'PUT', rawBody: createReadStream(staged.filePath),
        headers: { 'Content-Length': String(staged.bytes) },
        responseType: 'none', timeoutMs: config.providerUploadTimeoutMs });
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
        onStage('ACTIVE', { imageId: image.id, bytes: staged.bytes });
        return { image: current, processing: false };
      }
      if (['killed', 'deleted', 'pending_delete'].includes(current.status)) {
        await cleanup();
        throw new OSError(502, 'Glance rejected the image.', 'image_upload_failed');
      }
      if (attempt < pollAttempts - 1) await pause(IMAGE_POLL_DELAY_MS);
    }
    onStage('PROCESSING', { imageId: image.id, bytes: staged.bytes });
    return { image: { id: image.id, status: 'processing' }, processing: true };
  } finally {
    await rm(staged.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    onStage('CLEANUP_TEMP_FILE', { bytes: staged.bytes });
  }
}
