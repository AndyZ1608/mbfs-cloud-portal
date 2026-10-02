import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { imageDiskFormat, uploadImage } from '../imageUpload.js';

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

test('source stream failure also cleans the partial image', async () => {
  const fixture = glance();
  const source = Readable.from((async function* () { yield Buffer.from('part'); throw new Error('source failure'); })());
  await assert.rejects(uploadImage(session, { filename: 'test.iso', name: 'Recovery', source },
    { request: fixture.request }), { code: 'image_upload_failed' });
  assert.equal(fixture.calls.at(-1).options.method, 'DELETE');
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
