// objectstore.js — Object Storage (Swift / Ceph RGW qua Swift API)
// Endpoint Swift đã chứa /v1/AUTH_<project> nên KHÔNG cắt hậu tố như service khác.
import { Router } from 'express';
import crypto from 'node:crypto';
import { endpointFor, OSError, MOCK, providerFetch } from '../openstack.js';
import { config } from '../config.js';
import { mockObject } from '../mock.js';

const router = Router();
const INSECURE = String(process.env.OS_INSECURE || '').toLowerCase() === 'true';

function base(sess) {
  const url = endpointFor(sess.catalog, 'object');
  return url.replace(/\/+$/, '');
}

// Gọi Swift trực tiếp (cần header + stream, không dùng osFetch)
async function swift(sess, path, { method = 'GET', headers = {}, body, raw } = {}) {
  if (MOCK) return mockObject(method, path, headers, body, raw);
  const url = base(sess) + path;
  const h = { 'X-Auth-Token': sess.token, ...headers };
  const opts = { method, headers: h };
  if (raw !== undefined) { opts.body = raw; opts.duplex = 'half'; }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const timeout = raw !== undefined ? config.providerUploadTimeoutMs : config.providerTimeoutMs;
  const res = await providerFetch(url, opts, timeout);
  if (!res.ok) throw new OSError(res.status, `Object Storage lỗi ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

router.get('/object/available', (req, res) => {
  if (MOCK) return res.json({ available: true });
  try { base(req.session.os); res.json({ available: true }); }
  catch { res.json({ available: false }); }
});

// ----- Container -----
router.get('/object/containers', async (req, res, next) => {
  try {
    const r = await swift(req.session.os, '/?format=json');
    res.json({ containers: MOCK ? r : await r.json() });
  } catch (e) { next(e); }
});

router.post('/object/containers', async (req, res, next) => {
  try {
    const { name, public: pub } = req.body || {};
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(name || '')) throw new OSError(400, 'Tên container không hợp lệ');
    const headers = pub ? { 'X-Container-Read': '.r:*,.rlistings' } : {};
    await swift(req.session.os, `/${encodeURIComponent(name)}`, { method: 'PUT', headers });
    console.log(`[object] CREATE container=${name} public=${!!pub} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/object/containers/:name', async (req, res, next) => {
  try {
    await swift(req.session.os, `/${encodeURIComponent(req.params.name)}`, { method: 'DELETE' });
    console.log(`[object] DELETE container=${req.params.name} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----- Object -----
router.get('/object/containers/:name/objects', async (req, res, next) => {
  try {
    const prefix = req.query.prefix ? `&prefix=${encodeURIComponent(req.query.prefix)}` : '';
    const r = await swift(req.session.os, `/${encodeURIComponent(req.params.name)}?format=json&limit=1000${prefix}`);
    res.json({ objects: MOCK ? r : await r.json() });
  } catch (e) { next(e); }
});

router.put('/object/containers/:name/objects/*', async (req, res, next) => {
  try {
    const key = req.params[0];
    await swift(req.session.os, `/${encodeURIComponent(req.params.name)}/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT', raw: req, headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
    });
    console.log(`[object] UPLOAD ${req.params.name}/${key} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/object/containers/:name/objects/*', async (req, res, next) => {
  try {
    const key = req.params[0];
    const r = await swift(req.session.os, `/${encodeURIComponent(req.params.name)}/${key.split('/').map(encodeURIComponent).join('/')}`);
    res.setHeader('Content-Disposition', `attachment; filename="${key.split('/').pop().replace(/"/g, '')}"`);
    if (MOCK) return res.send(Buffer.from(r.body || ''));
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    const len = r.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) { next(e); }
});

router.delete('/object/containers/:name/objects/*', async (req, res, next) => {
  try {
    const key = req.params[0];
    await swift(req.session.os, `/${encodeURIComponent(req.params.name)}/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
    console.log(`[object] DELETE ${req.params.name}/${key} by=${req.session.os.user.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----- Link chia sẻ tạm thời (Swift TempURL) -----
router.post('/object/temp-url', async (req, res, next) => {
  try {
    const sess = req.session.os;
    const { container, object, seconds = 3600 } = req.body || {};
    if (!container || !object) throw new OSError(400, 'Thiếu container/object');
    const ttl = Math.min(Math.max(Number(seconds) || 3600, 60), 7 * 86400);

    if (MOCK) {
      return res.json({ url: `https://swift.mbfs.vn/v1/AUTH_demo/${container}/${object}?temp_url_sig=mock&temp_url_expires=${Math.floor(Date.now() / 1000) + ttl}`, expires_in: ttl });
    }
    // Lấy hoặc tạo khoá TempURL ở cấp account
    const head = await swift(sess, '/', { method: 'HEAD' });
    let key = head.headers.get('x-account-meta-temp-url-key');
    if (!key) {
      key = crypto.randomBytes(24).toString('hex');
      await swift(sess, '/', { method: 'POST', headers: { 'X-Account-Meta-Temp-URL-Key': key } });
    }
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const full = base(sess);
    const path = new URL(full).pathname.replace(/\/+$/, '') + `/${container}/${object}`;
    const sig = crypto.createHmac('sha1', key).update(`GET\n${expires}\n${path}`).digest('hex');
    res.json({ url: `${new URL(full).origin}${path}?temp_url_sig=${sig}&temp_url_expires=${expires}`, expires_in: ttl });
  } catch (e) { next(e); }
});

export default router;
