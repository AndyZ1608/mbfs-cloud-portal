// scheduler.js — Backup tự động theo lịch (kiểu vBackup/FPT Backup bản gọn)
// Policy: snapshot volume hoặc image VM theo lịch hàng ngày/hàng tuần,
// tự xoá bản cũ theo retention. Giờ tính theo TZ của container (đặt TZ trong .env).
import { osFetch } from './openstack.js';
import { getServiceSession, svcConfigured } from './svcauth.js';
import { loadJson, saveJson } from './store.js';
import { record } from './audit.js';
import { pushNotice } from './notify.js';

let policies = loadJson('policies.json', []);
const save = () => saveJson('policies.json', policies);
const ranSlots = new Set(); // chống chạy trùng trong cùng một phút

export const listPolicies = (projectId) => policies.filter((p) => p.project_id === projectId);

export function addPolicy(p) {
  policies.push(p);
  save();
  return p;
}

export function patchPolicy(id, projectId, patch) {
  const p = policies.find((x) => x.id === id && x.project_id === projectId);
  if (!p) return null;
  if (patch.enabled !== undefined) p.enabled = !!patch.enabled;
  if (patch.retention !== undefined) p.retention = Math.max(1, Math.min(90, Number(patch.retention) || p.retention));
  if (patch.schedule) p.schedule = { ...p.schedule, ...patch.schedule };
  save();
  return p;
}

export function removePolicy(id, projectId) {
  const i = policies.findIndex((x) => x.id === id && x.project_id === projectId);
  if (i < 0) return false;
  policies.splice(i, 1);
  save();
  return true;
}

const sanitize = (s) => String(s || 'noname').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40);

// Tính giờ theo TZ bằng Intl (ICU bundle sẵn trong Node) — KHÔNG cần tzdata
// của hệ điều hành, nên image Alpine không phải apk add gì (build offline được).
const RAW_TZ = process.env.TZ || 'UTC';
let SCHED_TZ = RAW_TZ;
try { new Intl.DateTimeFormat('en', { timeZone: RAW_TZ }); }
catch { console.warn(`[backup] TZ "${RAW_TZ}" không hợp lệ — dùng UTC`); SCHED_TZ = 'UTC'; }
export { SCHED_TZ };

const WD_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const TZ_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHED_TZ, hourCycle: 'h23',
  weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
export function nowParts(d = new Date()) {
  const parts = TZ_FMT.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    weekday: WD_MAP[get('weekday')] ?? d.getUTCDay(),
    year: get('year'), month: get('month'), day: get('day'),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}
const stamp = () => { const n = nowParts(); return `${n.year}${n.month}${n.day}-${String(n.hour).padStart(2, '0')}${String(n.minute).padStart(2, '0')}`; };

function isDue(pol, np) {
  const { freq, hour, minute, weekday } = pol.schedule;
  if (np.hour !== hour || np.minute !== minute) return false;
  if (freq === 'weekly' && np.weekday !== Number(weekday)) return false;
  return true;
}

export async function runPolicy(pol) {
  const sess = await getServiceSession(pol.project_id);
  const prefix = `auto-${sanitize(pol.target_name)}-`;
  const name = prefix + stamp();
  let created; let pruned = 0;

  if (pol.type === 'volume') {
    const d = await osFetch(sess, 'volume', '/snapshots', {
      method: 'POST',
      body: { snapshot: { volume_id: pol.target_id, name, force: true, description: `mbfs-portal policy ${pol.id}` } },
    });
    created = d.snapshot?.id;
    // prune theo retention
    const all = (await osFetch(sess, 'volume', '/snapshots/detail?limit=1000')).snapshots || [];
    const mine = all
      .filter((s) => s.volume_id === pol.target_id && (s.name || '').startsWith(prefix) && !/deleting/.test(s.status || ''))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    for (const old of mine.slice(pol.retention)) {
      try { await osFetch(sess, 'volume', `/snapshots/${old.id}`, { method: 'DELETE' }); pruned++; } catch { /* bản đang bận, kỳ sau xoá */ }
    }
  } else { // 'server' → tạo image
    await osFetch(sess, 'compute', `/servers/${pol.target_id}/action`, {
      method: 'POST',
      body: { createImage: { name, metadata: { mbfs_policy: pol.id } } },
    });
    created = name;
    const all = (await osFetch(sess, 'image', '/v2/images?limit=200&sort=created_at:desc')).images || [];
    const mine = all.filter((i) => (i.name || '').startsWith(prefix) && ['active', 'error'].includes(i.status));
    for (const old of mine.slice(pol.retention)) {
      try { await osFetch(sess, 'image', `/v2/images/${old.id}`, { method: 'DELETE' }); pruned++; } catch { /* kỳ sau */ }
    }
  }
  pol.last_run = { ts: new Date().toISOString(), status: 'ok', message: `Đã tạo ${name}${pruned ? `, xoá ${pruned} bản cũ` : ''}` };
  pushNotice({ project_id: pol.project_id, project_name: pol.project_name, level: 'ok', title: `Backup thành công: ${pol.target_name}`, detail: pol.last_run.message, link: '/backup', code: 'backupSucceeded', values: { name: pol.target_name, created: name, pruned } });
  save();
  record({ user: 'portal-task', project: { id: pol.project_id, name: pol.project_name }, method: 'JOB', path: `/backup/run/${pol.type}/${pol.target_name}`, status: 200, ms: 0 });
  return { created, pruned };
}

async function tick() {
  if (!svcConfigured()) return;
  const np = nowParts();
  for (const pol of policies) {
    if (!pol.enabled || !isDue(pol, np)) continue;
    const slot = `${pol.id}:${np.year}-${np.month}-${np.day}-${np.hour}:${np.minute}`;
    if (ranSlots.has(slot)) continue;
    ranSlots.add(slot);
    if (ranSlots.size > 500) ranSlots.clear();
    try {
      await runPolicy(pol);
      console.log(`[backup] OK policy=${pol.id} ${pol.type}/${pol.target_name}`);
    } catch (e) {
      pol.last_run = { ts: new Date().toISOString(), status: 'error', message: e.message };
      save();
      pushNotice({ project_id: pol.project_id, project_name: pol.project_name, level: 'error', title: `Backup LỖI: ${pol.target_name}`, detail: e.message, link: '/backup', code: 'backupFailed', values: { name: pol.target_name } });
      record({ user: 'portal-task', project: { id: pol.project_id, name: pol.project_name }, method: 'JOB', path: `/backup/run/${pol.type}/${pol.target_name}`, status: 500, ms: 0 });
      console.warn(`[backup] LỖI policy=${pol.id}: ${e.message}`);
    }
  }
}

export function startScheduler() {
  if (!svcConfigured()) {
    console.log('[backup] Scheduler tắt — chưa cấu hình OS_TASK_USERNAME/OS_TASK_PASSWORD');
    return;
  }
  setInterval(() => tick().catch((e) => console.warn('[backup] tick lỗi:', e.message)), 30000);
  console.log(`[backup] Scheduler bật — ${policies.length} policy, giờ theo ${SCHED_TZ} (Intl/ICU, không cần tzdata hệ thống)`);
}
