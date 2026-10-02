import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { imageDiskFormat, stageImageToTemp, uploadImage, validateImageContentLength } from '../imageUpload.js';
import { MAX_IMAGE_UPLOAD_BYTES, imageUploadSizeAllowed } from '../../shared/imageUploadPolicy.mjs';

const session = { project: { id: 'project-a' }, token: 'SECRET-TOKEN' };
const file = (bytes = 'image-bytes') => Readable.from([Buffer.from(bytes)]);

function glance({ failCreate = false, failPut = false, status = 'active' } = {}) {
  const calls = [];
  const request = async (_session, service, path, options = {}) => {
    assert.equal(_session, session);
    assert.equal(service, 'image');
    calls.push({ path, options });
    if (path === '/v2/images' && options.method === 'POST') {
      if (failCreate) throw Object.assign(new Error('SECRET'), { status: 503 });
      return { id: 'new-image', owner: 'project-a', status: 'queued' };
    }
    if (path === '/v2/images/new-image/file' && options.method === 'PUT') {
      assert.equal(Buffer.isBuffer(options.rawBody), false);
      const chunks = [];
      for await (const chunk of options.rawBody) chunks.push(chunk);
      if (failPut) throw Object.assign(new Error('SECRET'), { status: 500 });
      return null; // Glance 204 No Content
    }
    if (path === '/v2/images/new-image' && options.method === 'DELETE') return null;
    if (path === '/v2/images/new-image' && !options.method) {
      return { id: 'new-image', owner: 'project-a', status };
    }
    throw new Error(`Unexpected provider call: ${path}`);
  };
  return { request, calls };
}

test('format policy accepts QCOW2/ISO regardless of case, rejects other extensions and paths', () => {
  for (const [name, format] of [['test.qcow2', 'qcow2'], ['test.QCOW2', 'qcow2'],
    ['test.iso', 'iso'], ['test.ISO', 'iso']]) assert.equal(imageDiskFormat(name), format);
  for (const name of ['test.raw', 'test.img', 'test.qcow2.gz', 'test.vmdk', 'test.iso/evil', '../test.iso']) {
    assert.equal(imageDiskFormat(name), null);
  }
});

test('strict 15 GiB boundary is shared by browser and backend length policy', () => {
  for (const size of [MAX_IMAGE_UPLOAD_BYTES - 1, 14 * 1024 ** 3, 5 * 1024 ** 3]) {
    assert.equal(imageUploadSizeAllowed(size), true);
    assert.equal(validateImageContentLength(String(size)), size);
  }
  for (const size of [MAX_IMAGE_UPLOAD_BYTES, 16 * 1024 ** 3, 20 * 1024 ** 3]) {
    assert.equal(imageUploadSizeAllowed(size), false);
    assert.throws(() => validateImageContentLength(String(size)), { status: 413, code: 'image_upload_too_large' });
  }
});

test('actual streamed byte count rejects exact and over-limit uploads before Glance and cleans partial files', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cmp-image-upload-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = glance();
  for (const chunks of [[4, 6], [4, 7], [9, 7]]) {
    const source = Readable.from(chunks.map((count) => Buffer.alloc(count)));
    await assert.rejects(uploadImage(session, { filename: 'test.iso', name: 'Boundary', source },
      { request: fixture.request, tempRoot, maxBytes: 10 }), { status: 413, code: 'image_upload_too_large' });
    assert.deepEqual(await readdir(tempRoot), []);
  }
  assert.deepEqual(fixture.calls, []);
  await uploadImage(session, { filename: 'test.iso', name: 'Under boundary',
    source: Readable.from([Buffer.alloc(9)]) }, { request: fixture.request, tempRoot, maxBytes: 10 });
  assert.deepEqual(await readdir(tempRoot), []);
  assert.equal(fixture.calls[1].options.headers['Content-Length'], '9');
});

test('temporary upload is removed when Glance metadata creation fails', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cmp-image-upload-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = glance({ failCreate: true });
  await assert.rejects(uploadImage(session, { filename: 'test.iso', name: 'Failure', source: file() },
    { request: fixture.request, tempRoot }), { code: 'image_create_failed' });
  assert.deepEqual(await readdir(tempRoot), []);
});

test('stream failure removes its partial temporary file before Glance', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cmp-image-upload-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = glance();
  const source = Readable.from((async function* () { yield Buffer.from('part'); throw new Error('broken'); })());
  await assert.rejects(uploadImage(session, { filename: 'test.iso', name: 'Broken', source },
    { request: fixture.request, tempRoot }), { code: 'image_upload_receive_failed' });
  assert.deepEqual(await readdir(tempRoot), []);
  assert.deepEqual(fixture.calls, []);
});

for (const [filename, format] of [['test.qcow2', 'qcow2'], ['test.ISO', 'iso']]) {
  test(`${filename} creates private Glance metadata, streams raw bytes, handles empty PUT body, verifies active`, async () => {
    const fixture = glance();
    const result = await uploadImage(session, { filename, name: 'Custom image', source: file(), contentLength: 11 },
      { request: fixture.request, pause: async () => {} });
    assert.equal(result.processing, false);
    assert.equal(result.image.status, 'active');
    assert.deepEqual(fixture.calls.map((call) => call.path), ['/v2/images', '/v2/images/new-image/file', '/v2/images/new-image']);
    assert.deepEqual(fixture.calls[0].options.body, { name: 'Custom image', disk_format: format,
      container_format: 'bare', visibility: 'private' });
    assert.equal(fixture.calls[1].options.timeoutMs, config.providerUploadTimeoutMs);
    assert.equal(fixture.calls[1].options.headers['Content-Length'], '11');
    assert.equal(fixture.calls[1].options.responseType, 'none');
  });
}

test('unsupported filename is rejected before any Glance metadata is created', async () => {
  const fixture = glance();
  await assert.rejects(uploadImage(session, { filename: 'test.qcow2.gz', name: 'Bad', source: file() },
    { request: fixture.request }), { status: 400, code: 'image_unsupported_format' });
  assert.deepEqual(fixture.calls, []);
});

test('metadata create failure never sends file bytes and exposes no provider secret', async () => {
  const fixture = glance({ failCreate: true });
  await assert.rejects(uploadImage(session, { filename: 'test.iso', name: 'Recovery', source: file() },
    { request: fixture.request }), (error) => error.code === 'image_create_failed' && !error.message.includes('SECRET'));
  assert.deepEqual(fixture.calls.map((call) => call.path), ['/v2/images']);
});

test('binary upload failure deletes only the newly created partial image', async () => {
  const fixture = glance({ failPut: true });
  await assert.rejects(uploadImage(session, { filename: 'test.iso', name: 'Recovery', source: file() },
    { request: fixture.request }), { code: 'image_upload_failed' });
  assert.deepEqual(fixture.calls.map((call) => call.path),
    ['/v2/images', '/v2/images/new-image/file', '/v2/images/new-image']);
  assert.equal(fixture.calls.at(-1).options.method, 'DELETE');
});

test('source stream failure is rejected before any Glance metadata exists', async () => {
  const fixture = glance();
  const source = Readable.from((async function* () { yield Buffer.from('part'); throw new Error('source failure'); })());
  await assert.rejects(uploadImage(session, { filename: 'test.iso', name: 'Recovery', source },
    { request: fixture.request }), { code: 'image_upload_receive_failed' });
  assert.deepEqual(fixture.calls, []);
});

test('Glance processing state is not reported as upload success', async () => {
  const fixture = glance({ status: 'saving' });
  const result = await uploadImage(session, { filename: 'test.iso', name: 'Recovery', source: file() },
    { request: fixture.request, pause: async () => {}, pollAttempts: 2 });
  assert.equal(result.processing, true);
  assert.equal(result.image.status, 'processing');
  assert.ok(!fixture.calls.some((call) => call.options.method === 'DELETE'));
});

test('Glance killed state fails and removes the image created by this request', async () => {
  const fixture = glance({ status: 'killed' });
  await assert.rejects(uploadImage(session, { filename: 'test.iso', name: 'Recovery', source: file() },
    { request: fixture.request, pause: async () => {} }), { code: 'image_upload_failed' });
  assert.equal(fixture.calls.at(-1).options.method, 'DELETE');
});
