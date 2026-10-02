import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';

process.env.OS_MOCK = 'false';

test('the non-mock Glance transport receives raw ISO bytes with scoped token and accepts empty 204', async (t) => {
  const seen = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, path: req.url, headers: req.headers, bytes: Buffer.concat(chunks) });
    if (req.method === 'POST' && req.url === '/v2/images') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'created-image', owner: 'project-a', status: 'queued' }));
    } else if (req.method === 'PUT' && req.url === '/v2/images/created-image/file') {
      res.writeHead(204, { 'Content-Type': 'application/json' });
      res.end();
    } else if (req.method === 'GET' && req.url === '/v2/images/created-image') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'created-image', owner: 'project-a', status: 'active',
        disk_format: 'iso', container_format: 'bare', size: 12 }));
    } else { res.writeHead(404); res.end(); }
  }).listen(0);
  await new Promise((resolve) => provider.once('listening', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const { uploadImage } = await import('../imageUpload.js');
  const payload = Buffer.from('ISO-RAW-DATA');
  const session = { token: 'project-a-token', project: { id: 'project-a' },
    catalog: [{ type: 'image', endpoints: [{ interface: 'public', url: `http://127.0.0.1:${provider.address().port}` }] }] };
  const result = await uploadImage(session, { filename: 'recovery.ISO', name: 'Recovery',
    source: Readable.from([payload]), contentLength: payload.length });
  assert.equal(result.image.status, 'active');
  assert.deepEqual(seen.map((item) => `${item.method} ${item.path}`),
    ['POST /v2/images', 'PUT /v2/images/created-image/file', 'GET /v2/images/created-image']);
  assert.equal(JSON.parse(seen[0].bytes.toString()).disk_format, 'iso');
  assert.deepEqual(seen[1].bytes, payload);
  assert.equal(seen[1].headers['content-type'], 'application/octet-stream');
  assert.equal(seen[1].headers['x-auth-token'], 'project-a-token');
});
