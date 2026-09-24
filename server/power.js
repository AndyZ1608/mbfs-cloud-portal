// power.js — Lịch bật/tắt máy ảo theo giờ (tiết kiệm chi phí máy dev/test).
// Dùng chung đồng hồ TZ với scheduler backup; chạy bằng tài khoản dịch vụ OS_TASK_*.
import { osFetch } from './openstack.js';
import { getServiceSession, svcConfigured } from './svcauth.js';
import { loadJson, saveJson } from './store.js';
import { nowParts, SCHED_TZ } from './scheduler.js';
import { record } from './audit.js';
import { pushNotice } from './notify.js';
import { fetchOwned } from './projectScope.js';

let rules = loadJson('power-rules.json', []);
const save = () => saveJson('power-rules.json', rules);
const ran = new Set();

export const listRules = (pid) => rules.filter((r) => r.project_id === pid);
export const addRule = (r) => { rules.push(r); save(); return r; };
export function patchRule(id, pid, p) {
  const r = rules.find((x) => x.id === id && x.project_id === pid);
  if (!r) return null;
  if (p.enabled !== undefined) r.enabled = !!p.enabled;
  save();
  return r;
}
export function removeRule(id, pid) {
  const i = rules.findIndex((x) => x.id === id && x.project_id === pid);
  if (i < 0) return false;
  rules.splice(i, 1); save(); return true;
}

// Ước tính giờ máy được tắt mỗi tuần theo lịch (để hiển thị tiết kiệm)
export function offHoursPerWeek(rule) {
  if (rule.action !== 'stop' || !rule.pair_start) return 0;
  const mins = (h, m) => h * 60 + m;
  let d = mins(rule.pair_start.hour, rule.pair_start.minute) - mins(rule.schedule.hour, rule.schedule.minute);
  if (d <= 0) d += 1440;
  return (d / 60) * (rule.schedule.days?.length || 0);
}

async function fire(rule) {
  const sess = await getServiceSession(rule.project_id);
  await fetchOwned(sess, 'compute', `/servers/${encodeURIComponent(rule.server_id)}`, 'server');
  const body = rule.action === 'stop' ? { 'os-stop': null } : { 'os-start': null };
  await osFetch(sess, 'compute', `/servers/${rule.server_id}/action`, { method: 'POST', body });
  rule.last_run = { ts: new Date().toISOString(), status: 'ok', message: rule.action === 'stop' ? 'Đã tắt máy' : 'Đã bật máy' };
  save();
  record({ user: 'portal-task', project: { id: rule.project_id, name: rule.project_name }, method: 'JOB', path: `/power/${rule.action}/${rule.server_name}`, status: 200, ms: 0 });
  pushNotice({ project_id: rule.project_id, project_name: rule.project_name, level: 'info', title: `${rule.action === 'stop' ? 'Đã tắt' : 'Đã bật'} máy theo lịch: ${rule.server_name}`, link: '/power', code: rule.action === 'stop' ? 'powerStopped' : 'powerStarted', values: { name: rule.server_name } });
}

async function tick() {
  if (!svcConfigured()) return;
  const np = nowParts();
  for (const r of rules) {
    if (!r.enabled) continue;
    const s = r.schedule;
    if (np.hour !== s.hour || np.minute !== s.minute) continue;
    if (!(s.days || []).includes(np.weekday)) continue;
    const slot = `${r.id}:${np.year}${np.month}${np.day}${np.hour}:${np.minute}`;
    if (ran.has(slot)) continue;
    ran.add(slot);
    if (ran.size > 500) ran.clear();
    try {
      await fire(r);
      console.log(`[power] ${r.action.toUpperCase()} ${r.server_name}`);
    } catch (e) {
      r.last_run = { ts: new Date().toISOString(), status: 'error', message: e.message };
      save();
      pushNotice({ project_id: r.project_id, project_name: r.project_name, level: 'error', title: `Lịch ${r.action === 'stop' ? 'tắt' : 'bật'} máy lỗi: ${r.server_name}`, detail: e.message, link: '/power', code: r.action === 'stop' ? 'powerStopFailed' : 'powerStartFailed', values: { name: r.server_name } });
      console.warn(`[power] LỖI ${r.server_name}: ${e.message}`);
    }
  }
}

export function startPower() {
  if (!svcConfigured()) { console.log('[power] Lịch bật/tắt tắt — chưa cấu hình OS_TASK_*'); return; }
  setInterval(() => tick().catch((e) => console.warn('[power] tick lỗi:', e.message)), 30000);
  console.log(`[power] Lịch bật/tắt máy ảo bật — ${rules.length} quy tắc, giờ theo ${SCHED_TZ}`);
}
export const powerConfigured = () => svcConfigured();
