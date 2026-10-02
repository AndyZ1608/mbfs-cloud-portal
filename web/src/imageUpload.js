import { apiErrorMessage } from './api.js';
import { imageUploadSizeAllowed } from '../../shared/imageUploadPolicy.mjs';

export function imageUploadFormat(filename) {
  const extension = typeof filename === 'string' ? filename.match(/\.([^.]+)$/)?.[1]?.toLowerCase() : null;
  return extension === 'qcow2' || extension === 'iso' ? extension : null;
}

export function uploadImageFile({ file, name, minDisk, minRam, onProgress = () => {}, onRequest = () => {},
  createRequest = () => new XMLHttpRequest() }) {
  if (!imageUploadSizeAllowed(file?.size)) {
    return Promise.reject(new Error(apiErrorMessage({ code: 'image_upload_too_large' }, 413)));
  }
  return new Promise((resolve, reject) => {
    const xhr = createRequest();
    onRequest(xhr);
    xhr.open('POST', '/api/images/upload');
    xhr.setRequestHeader('X-CMP-Request', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Image-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Image-Name', encodeURIComponent(name));
    if (minDisk !== '') xhr.setRequestHeader('X-Image-Min-Disk', String(minDisk));
    if (minRam !== '') xhr.setRequestHeader('X-Image-Min-Ram', String(minRam));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status === 200 && data?.image?.status === 'active' && data.processing === false) resolve(data);
      else if (xhr.status === 202 && data?.processing === true) resolve(data);
      else reject(new Error(apiErrorMessage(data, xhr.status)));
    };
    xhr.onerror = () => reject(new Error(apiErrorMessage({ code: 'image_upload_network_error' }, 502)));
    xhr.onabort = () => reject(new Error(apiErrorMessage({ code: 'image_upload_cancelled' }, 400)));
    xhr.send(file);
  });
}
