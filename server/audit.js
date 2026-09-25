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

// Routes provide only reviewed operational metadata here, never request bodies.
// The middleware adds actor, scoped project, request status and timestamp once.
export function setInstanceAudit(res, event) {
  res.locals.instanceAudit = event;
}

export function addInstanceAudit(res, event) {
  (res.locals.instanceAudits ||= []).push(event);
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

// Only explicit instance identifiers or exact server-resource paths qualify. Never return
// request bodies or provider diagnostics (password changes are intentionally metadata-only).
export function listInstanceAudit({ projectId, instanceId, limit = 100, offset = 0 }) {
  const out = [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 300));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  let skipped = 0;
  for (let i = MEM.length - 1; i >= 0 && out.length < safeLimit; i--) {
    const entry = MEM[i];
    if (entry.project?.id !== projectId) continue;
    const pathId = entry.path?.match(/^\/servers\/([^/]+)(?:\/|$)/)?.[1];
    const interfaces = Array.isArray(entry.interfaces) ? entry.interfaces : [];
    const related = entry.resource_type === 'instance' && entry.resource_id === instanceId
      || entry.instance_id === instanceId || pathId === instanceId
      || interfaces.some((item) => item.instance_id === instanceId);
    if (!related) continue;
    if (skipped++ < safeOffset) continue;
    out.push({ ts: entry.ts, action: entry.action, user: entry.user,
      result: entry.result, status: entry.status, source: entry.source || 'cmp',
      resource_name: entry.resource_name || entry.instance_name || null,
      details: entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details)
        ? entry.details : { interfaces: interfaces.filter((item) => item.instance_id === instanceId)
          .map((item) => ({ port_id: item.port_id, fixed_ip: item.fixed_ip })) } });
  }
  return out;
}

const SERVER_ACTIONS = {
  start: 'instance.start', stop: 'instance.stop',
  'reboot-soft': 'instance.reboot.soft', 'reboot-hard': 'instance.reboot.hard',
  resize: 'instance.resize.request', 'confirm-resize': 'instance.resize.confirm',
  'revert-resize': 'instance.resize.revert', snapshot: 'instance.snapshot.create',
  shelve: 'instance.shelve', unshelve: 'instance.unshelve',
  pause: 'instance.pause', unpause: 'instance.unpause',
};

export function instanceActionCode(action) { return SERVER_ACTIONS[action] || null; }

function fallbackInstanceAudit(req, path) {
  const method = req.method;
  if (path === '/api/servers' && method === 'POST') return { action: 'instance.create' };
  const match = path.match(/^\/api\/servers\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const resourceId = match[1];
  const suffix = match[2] || '';
  let action = null;
  if (!suffix && method === 'PUT') action = 'instance.rename';
  else if (!suffix && method === 'DELETE') action = 'instance.delete';
  else if (suffix === 'action' && method === 'POST') action = SERVER_ACTIONS[req.body?.action] || null;
  else if (suffix === 'change-password' && method === 'POST') action = 'instance.password.change';
  else if (suffix === 'console' && method === 'POST') action = 'instance.console.open';
  else if (suffix === 'rebuild' && method === 'POST') action = 'instance.rebuild';
  else if (suffix === 'security-groups' && method === 'POST') action = 'instance.security_groups.change';
  else if (suffix === 'interfaces' && method === 'POST') action = 'instance.interface.attach';
  else if (suffix.startsWith('interfaces/') && method === 'DELETE') action = 'instance.interface.detach';
  return action ? { action, resourceId } : null;
}

// Ghi tự động các thao tác ghi (trừ nhánh /auth — xử lý riêng để lấy username khi login)
export function auditMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // /auth/login đã có auditLogin ghi riêng (lấy được username từ body)
  if ((req.originalUrl || req.url).startsWith('/api/auth/login')) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      const os = req.session?.os;
      const path = (req.originalUrl || req.url).split('?')[0];
      const base = {
        request_id: req.id, user: os?.user?.name || null,
        project: os?.project ? { id: os.project.id, name: os.project.name } : null,
        project_id: os?.project?.id || null,
        provider: 'openstack', source: 'cmp', cloud: config.cloudName,
        region: config.region || null, method: req.method,
        path: path.replace(/^\/api/, ''), status: res.statusCode,
        source_ip: clientIp(req), ms: Date.now() - t0,
      };
      const events = res.locals.instanceAudits?.length ? res.locals.instanceAudits :
        [res.locals.instanceAudit || fallbackInstanceAudit(req, path)];
      if (res.locals.instanceAudits?.length && res.statusCode >= 400) {
        events.push({ action: 'instance.create', result: 'failure' });
      }
      for (const event of events) {
        const result = res.statusCode >= 400 && !(event?.status === 202 && event?.result === 'accepted') ? 'failure'
          : event?.result || (res.statusCode === 202 ? 'accepted' : 'success');
        record({ ...base,
          action: event?.action || `${req.method.toLowerCase()}.${path.replace(/^\/api\/?/, '').split('/')[0] || 'api'}`,
          ...(event?.action?.startsWith('instance.') ? {
            resource_type: 'instance', resource_id: event.resourceId || null,
            resource_name: event.resourceName || null,
            instance_id: event.resourceId || null, instance_name: event.resourceName || null,
            details: event.details || {},
          } : {}),
          ...(event?.legacy || {}),
          status: event?.status || base.status, result,
        });
      }
    } catch {
      console.error(`[audit] Could not record request_id=${req.id} status=${res.statusCode}`);
    }
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
