// Test tự động — chạy bằng node --test (không cần thư viện ngoài)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.OS_MOCK = 'true';
process.env.DATA_DIR = fileURLToPath(new URL('../.test-data', import.meta.url));
process.env.TZ = 'Asia/Ho_Chi_Minh';

test('templates: render cloud-init hợp lệ và chặn tham số độc hại', async () => {
  const { TEMPLATES, findTemplate, collectParams } = await import('../templates.js');
  assert.ok(TEMPLATES.length >= 10, 'phải có ít nhất 10 template');
  const pg = findTemplate('postgres');
  const p = collectParams(pg, { db_name: 'appdb', db_user: 'appuser', db_pass: 'Passw0rd@123' });
  const ud = pg.userData(p);
  assert.match(ud, /^#cloud-config/);
  assert.match(ud, /POSTGRES_DB: appdb/);
  assert.throws(() => collectParams(pg, { db_name: 'bad name; rm -rf /', db_user: 'u', db_pass: 'Passw0rd@123' }), /không hợp lệ/);
});

test('scheduler: nowParts đổi đúng múi giờ Việt Nam (+7)', async () => {
  const { nowParts, SCHED_TZ } = await import('../scheduler.js');
  assert.equal(SCHED_TZ, 'Asia/Ho_Chi_Minh');
  const np = nowParts();
  const expect = (new Date().getUTCHours() + 7) % 24;
  assert.equal(np.hour, expect);
  assert.ok(np.weekday >= 0 && np.weekday <= 6);
});

test('rate limit: chặn sau khi vượt ngưỡng, có Retry-After', async () => {
  const { rateLimit } = await import('../security.js');
  const mw = rateLimit({ windowSec: 60, max: 3, keyPrefix: 'test' + Math.random() });
  const req = { headers: {}, ip: '1.2.3.4', socket: {} };
  const mk = () => { const h = {}; return { setHeader: (k, v) => (h[k] = v), status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, h }; };
  for (let i = 0; i < 3; i++) { const res = mk(); let ok = false; mw(req, res, () => (ok = true)); assert.ok(ok, `lần ${i + 1} phải qua`); }
  const res = mk(); let passed = false;
  mw(req, res, () => (passed = true));
  assert.equal(passed, false, 'lần thứ 4 phải bị chặn');
  assert.equal(res.code, 429);
  assert.ok(res.h['Retry-After']);
});

test('rate limit: hai IP khác nhau đếm riêng', async () => {
  const { rateLimit } = await import('../security.js');
  const mw = rateLimit({ windowSec: 60, max: 1, keyPrefix: 'iso' + Math.random() });
  const mk = () => ({ setHeader() {}, status() { return this; }, json() { return this; } });
  let a = false, b = false;
  mw({ headers: {}, ip: '10.0.0.1', socket: {} }, mk(), () => (a = true));
  mw({ headers: {}, ip: '10.0.0.2', socket: {} }, mk(), () => (b = true));
  assert.ok(a && b, 'mỗi IP có hạn mức riêng');
});

test('security headers: có đủ CSP và các header cốt lõi', async () => {
  const { securityHeaders } = await import('../security.js');
  const h = {};
  securityHeaders({}, { setHeader: (k, v) => (h[k] = v) }, () => {});
  assert.match(h['Content-Security-Policy'], /default-src 'self'/);
  assert.match(h['Content-Security-Policy'], /connect-src 'self' ws: wss:/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'SAMEORIGIN');
  assert.ok(h['Referrer-Policy']);
});

test('CSRF: chặn write thiếu header và cho phép API client hợp lệ', async () => {
  const { csrfProtection } = await import('../middleware.js');
  const makeReq = (headers = {}) => ({ method: 'POST', path: '/servers', get: (name) => headers[name.toLowerCase()] });
  let error;
  csrfProtection(makeReq(), {}, (e) => { error = e; });
  assert.equal(error?.status, 403);
  error = undefined;
  csrfProtection(makeReq({ 'x-cmp-request': '1', 'sec-fetch-site': 'same-origin' }), {}, (e) => { error = e; });
  assert.equal(error, undefined);
});

test('request context: giữ request ID hợp lệ và loại giá trị nguy hiểm', async () => {
  const { requestContext } = await import('../middleware.js');
  const run = (value) => {
    const req = { get: () => value }; const headers = {};
    requestContext(req, { setHeader: (k, v) => { headers[k] = v; } }, () => {});
    return { req, headers };
  };
  assert.equal(run('trace-123').req.id, 'trace-123');
  assert.notEqual(run('bad value\n').req.id, 'bad value\n');
});

test('openstack: endpointFor chọn đúng và cắt hậu tố phiên bản', async () => {
  const { endpointFor } = await import('../openstack.js');
  const catalog = [
    { type: 'compute', endpoints: [{ interface: 'public', region: 'RegionOne', url: 'https://nova:8774/v2.1' }] },
    { type: 'network', endpoints: [{ interface: 'public', region: 'RegionOne', url: 'https://neutron:9696/v2.0' }] },
    { type: 'object-store', endpoints: [{ interface: 'public', region: 'RegionOne', url: 'https://swift:8080/v1/AUTH_abc' }] },
  ];
  assert.equal(endpointFor(catalog, 'network'), 'https://neutron:9696');
  assert.equal(endpointFor(catalog, 'object'), 'https://swift:8080/v1/AUTH_abc', 'endpoint Swift KHÔNG được cắt');
  assert.throws(() => endpointFor(catalog, 'lb'), /load-balancer|không tìm|Không/i);
});

test('sessionstore: FileStore lưu, đọc, xoá và tôn trọng hạn dùng', async (t) => {
  const { FileStore } = await import('../sessionstore.js');
  const st = new FileStore(process.env.DATA_DIR, 60);
  await new Promise((r) => st.set('sid-1', { os: { user: { name: 'hieptd' } } }, r));
  const got = await new Promise((r) => st.get('sid-1', (e, v) => r(v)));
  assert.equal(got.os.user.name, 'hieptd');
  await new Promise((r) => st.destroy('sid-1', r));
  const gone = await new Promise((r) => st.get('sid-1', (e, v) => r(v)));
  assert.equal(gone, null);
  const st0 = new FileStore(process.env.DATA_DIR, -1); // đã hết hạn ngay
  await new Promise((r) => st0.set('sid-2', { a: 1 }, r));
  const exp = await new Promise((r) => st0.get('sid-2', (e, v) => r(v)));
  assert.equal(exp, null, 'phiên hết hạn phải trả null');
});

test('power: quy tắc chỉ khớp đúng thứ và đúng phút', async () => {
  const { addRule, listRules, removeRule } = await import('../power.js');
  const r = addRule({ id: 'test-rule', project_id: 'p-test', server_id: 's1', server_name: 'vm1', action: 'stop', schedule: { days: [1, 2], hour: 19, minute: 0 }, enabled: true });
  assert.equal(listRules('p-test').length, 1);
  assert.equal(listRules('p-khac').length, 0, 'không rò rỉ quy tắc sang project khác');
  assert.ok(removeRule('test-rule', 'p-test'));
});

test('audit: chỉ trả log của đúng project', async () => {
  const { record, listAudit } = await import('../audit.js');
  const tag = 'p-' + Math.random();
  record({ user: 'hieptd', project: { id: tag, name: 'x' }, method: 'POST', path: '/servers', status: 200, ms: 1 });
  record({ user: 'nguoikhac', project: { id: 'p-khac', name: 'y' }, method: 'POST', path: '/servers', status: 200, ms: 1 });
  const mine = listAudit({ projectId: tag, user: 'hieptd', limit: 10 });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].user, 'hieptd');
});

test('instance activity is exact-ID, current-project, newest-first, and metadata-only', async () => {
  const { record, listInstanceAudit } = await import('../audit.js');
  const projectId = `detail-${Math.random()}`;
  const instanceId = `vm-${Math.random()}`;
  record({ project: { id: projectId }, path: `/servers/${instanceId}/change-password`,
    instance_id: instanceId, action: 'instance.change_password', user: 'admin', result: 'success', password: 'SECRET' });
  record({ project: { id: projectId }, path: `/servers/${instanceId}-other/action`, action: 'post.servers' });
  record({ project: { id: 'other' }, path: `/servers/${instanceId}/action`, action: 'post.servers' });
  record({ project: { id: projectId }, path: `/servers/${instanceId}/action`, action: 'instance.resize', result: 'accepted' });
  const entries = listInstanceAudit({ projectId, instanceId });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'instance.resize');
  assert.equal(entries[1].action, 'instance.change_password');
  assert.ok(!JSON.stringify(entries).includes('SECRET'));
  assert.equal(listInstanceAudit({ projectId: 'other', instanceId: 'missing' }).length, 0);
});
