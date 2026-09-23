// audit.js — nhật ký hoạt động (ai làm gì, lúc nào, kết quả)
// Ghi tự động mọi request POST/PUT/PATCH/DELETE qua middleware; thêm thủ công
// cho login và tác vụ nền. Lưu RAM (5000 dòng gần nhất) + JSONL trong DATA_DIR.
import { appendJsonl, readJsonlTail } from './store.js';
import { clientIp } from './middleware.js';
import { config } from './config.js';

const MAX = 5000;
const MEM = readJsonlTail('audit.jsonl', MAX);
if (MEM.length) console.log(`[audit] Nạp lại ${MEM.length} dòng nhật ký từ DATA_DIR`);

export function record(e) {
  const entry = { ts: new Date().toISOString(), ...e };
  MEM.push(entry);
  if (MEM.length > MAX) MEM.shift();
  appendJsonl('audit.jsonl', entry);
}

export function listAudit({ projectId, user, limit = 300 }) {
  const out = [];
  for (let i = MEM.length - 1; i >= 0 && out.length < limit; i--) {
    const e = MEM[i];
    const sameProject = e.project?.id && e.project.id === projectId;
    const ownNoProject = !e.project?.id && e.user && e.user === user;
    if (sameProject || ownNoProject) out.push(e);
  }
  return out;
}

// Ghi tự động các thao tác ghi (trừ nhánh /auth — xử lý riêng để lấy username khi login)
export function auditMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // /auth/login đã có auditLogin ghi riêng (lấy được username từ body)
  if ((req.originalUrl || req.url).startsWith('/api/auth/login')) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const os = req.session?.os;
    const passwordChangeId = req.method === 'POST'
      ? (req.originalUrl || req.url).split('?')[0].match(/^\/api\/servers\/([^/]+)\/change-password$/)?.[1]
      : null;
    record({
      request_id: req.id,
      user: os?.user?.name || null,
      project: os?.project ? { id: os.project.id, name: os.project.name } : null,
      provider: 'openstack',
      cloud: config.cloudName,
      region: config.region || null,
      method: req.method,
      path: (req.originalUrl || req.url).replace(/^\/api/, '').split('?')[0],
      action: passwordChangeId ? 'instance.change_password' : `${req.method.toLowerCase()}.${(req.originalUrl || req.url).replace(/^\/api\/?/, '').split(/[/?]/)[0] || 'api'}`,
      ...(passwordChangeId ? { instance_id: passwordChangeId, instance_name: res.locals.passwordChangeInstanceName || null, username: 'ubuntu' } : {}),
      status: res.statusCode,
      result: res.statusCode < 400 ? 'success' : 'failure',
      source_ip: clientIp(req),
      ms: Date.now() - t0,
    });
  });
  next();
}

// Riêng cho POST /api/auth/login: lấy username từ body (không bao giờ ghi mật khẩu)
export function auditLogin(req, res, next) {
  const t0 = Date.now();
  res.on('finish', () => {
    record({
      request_id: req.id,
      user: req.body?.username || null,
      project: null,
      method: 'POST',
      path: '/auth/login',
      status: res.statusCode,
      result: res.statusCode < 400 ? 'success' : 'failure',
      source_ip: clientIp(req),
      ms: Date.now() - t0,
    });
  });
  next();
}
