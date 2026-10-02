import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { imageUploadFormat, uploadImageFile } from '../src/imageUpload.js';
import { translate } from '../src/i18n/index.js';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('frontend accepts QCOW2 and ISO by case-insensitive extension only', () => {
  for (const [name, format] of [['Ubuntu.qcow2', 'qcow2'], ['firewall.QCOW2', 'qcow2'],
    ['recovery.iso', 'iso'], ['Windows.ISO', 'iso']]) assert.equal(imageUploadFormat(name), format);
  for (const name of ['image.raw', 'image.img', 'image.qcow2.gz', 'image.vmdk']) {
    assert.equal(imageUploadFormat(name), null);
  }
  const page = source('../src/pages/Images.jsx');
  assert.match(page, /accept="\.qcow2,\.iso"/);
  assert.doesNotMatch(page, /disk_format: f\.disk_format|<select value=\{f\.disk_format\}/);
});

test('browser transfer reaching 100% does not resolve until CMP confirms active Glance image', async () => {
  let xhr;
  const progress = [];
  const pending = uploadImageFile({ file: { name: 'recovery.ISO' }, name: 'Recovery', minDisk: '', minRam: '',
    onProgress: (value) => progress.push(value), createRequest: () => {
      xhr = { upload: {}, headers: {}, open(method, path) { this.method = method; this.path = path; },
        setRequestHeader(key, value) { this.headers[key] = value; }, send(body) { this.body = body; } };
      return xhr;
    } });
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.path, '/api/images/upload');
  assert.equal(xhr.headers['X-Image-Filename'], 'recovery.ISO');
  assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
  xhr.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
  assert.deepEqual(progress, [100]);
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  xhr.status = 200;
  xhr.responseText = JSON.stringify({ image: { id: 'glance-image', status: 'active' }, processing: false });
  xhr.onload();
  assert.equal((await pending).image.status, 'active');
});

test('processing and failed provider results never produce confirmed success', async () => {
  for (const [status, body, expected] of [
    [202, { image: { status: 'processing' }, processing: true }, true],
    [502, { code: 'image_upload_failed' }, false],
    [200, { image: { status: 'queued' }, processing: false }, false],
  ]) {
    let xhr;
    const pending = uploadImageFile({ file: { name: 'test.qcow2' }, name: 'Test', minDisk: '', minRam: '',
      createRequest: () => { xhr = { upload: {}, open() {}, setRequestHeader() {}, send() {} }; return xhr; } });
    xhr.status = status;
    xhr.responseText = JSON.stringify(body);
    xhr.onload();
    if (expected) assert.equal((await pending).processing, true);
    else await assert.rejects(pending);
  }
});

test('image upload labels and errors are localized in Vietnamese and English', () => {
  for (const locale of ['vi', 'en']) {
    for (const key of ['images.unsupportedFormat', 'images.sendingToOpenStack', 'images.processing',
      'images.uploaded', 'errors.image_upload_failed']) assert.notEqual(translate(locale, key), key);
  }
});
