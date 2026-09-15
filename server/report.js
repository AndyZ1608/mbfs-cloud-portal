// report.js — Báo cáo chi phí định kỳ gửi Telegram (kiểu "hoá đơn tháng" của provider)
import { osFetch } from './openstack.js';
import { getServiceSession, getServiceProjects, svcConfigured } from './svcauth.js';
import { notify, telegramEnabled } from './alerts.js';
import { pushNotice } from './notify.js';
import { nowParts, SCHED_TZ } from './scheduler.js';
import { loadJson, saveJson } from './store.js';

const DAY = Number(process.env.REPORT_DAY_OF_MONTH ?? 1);     // 0 = tắt
const HOUR = Number(process.env.REPORT_HOUR ?? 8);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const P = {
  vcpu: num(process.env.PRICE_VCPU_HOUR), ram: num(process.env.PRICE_RAM_GB_HOUR), disk: num(process.env.PRICE_DISK_GB_HOUR),
  vol: num(process.env.PRICE_VOLUME_GB_HOUR), snap: num(process.env.PRICE_SNAPSHOT_GB_HOUR), fip: num(process.env.PRICE_FIP_HOUR),
};
const CUR = process.env.CURRENCY || 'VND';
let sent = loadJson('report-sent.json', {});

const parseUtc = (s) => {
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
  return Number.isFinite(t) ? t : null;
};
const HOUR_MS = 3600000;
const overlapH = (aS, aE, bS, bE) => Math.max(0, (Math.min(aE, bE) - Math.max(aS, bS)) / HOUR_MS);
const money = (x) => Math.round(x).toLocaleString('vi-VN');

// Tính chi phí một project trong khoảng [start, end)
export async function billProject(projectId, start, end) {
  const sess = await getServiceSession(projectId);
  const iso = (t) => new Date(t).toISOString().slice(0, 19);
  const [novaR, volR, snapR, fipR] = await Promise.allSettled([
    osFetch(sess, 'compute', `/os-simple-tenant-usage/${projectId}?start=${iso(start)}&end=${iso(end)}&detailed=1`),
    osFetch(sess, 'volume', '/volumes/detail?limit=1000'),
    osFetch(sess, 'volume', '/snapshots/detail?limit=1000'),
    osFetch(sess, 'network', '/v2.0/floatingips'),
  ]);
  const usages = novaR.status === 'fulfilled' ? novaR.value?.tenant_usage?.server_usages || [] : [];
  const volumes = volR.status === 'fulfilled' ? volR.value?.volumes || [] : [];
  const snaps = snapR.status === 'fulfilled' ? snapR.value?.snapshots || [] : [];
  const fips = fipR.status === 'fulfilled' ? fipR.value?.floatingips || [] : [];

  let compute = 0, vmHours = 0;
  const top = [];
  for (const s of usages) {
    const from = parseUtc(s.started_at) ?? start;
    const to = parseUtc(s.ended_at) ?? end;
    const h = overlapH(from, to, start, end);
    const rate = (s.vcpus || 0) * P.vcpu + ((s.memory_mb || 0) / 1024) * P.ram + (s.local_gb || 0) * P.disk;
    compute += h * rate; vmHours += h;
    top.push({ name: s.name, cost: h * rate });
  }
  const stor = volumes.reduce((a, v) => a + overlapH(parseUtc(v.created_at) ?? start, end, start, end) * (v.size || 0) * P.vol, 0)
    + snaps.reduce((a, v) => a + overlapH(parseUtc(v.created_at) ?? start, end, start, end) * (v.size || 0) * P.snap, 0);
  const net = fips.reduce((a, f) => a + overlapH(parseUtc(f.created_at) ?? start, end, start, end) * P.fip, 0);

  top.sort((a, b) => b.cost - a.cost);
  return { compute, storage: stor, network: net, total: compute + stor + net, vm_count: usages.length, vm_hours: vmHours, top: top.slice(0, 5) };
}

async function sendMonthly() {
  const now = new Date();
  const endD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const label = `${String(startD.getUTCMonth() + 1).padStart(2, '0')}/${startD.getUTCFullYear()}`;
  const projects = await getServiceProjects();
  const lines = [`📊 Báo cáo chi phí hạ tầng tháng ${label}`, ''];
  let grand = 0;
  for (const p of projects) {
    try {
      const b = await billProject(p.id, startD.getTime(), endD.getTime());
      grand += b.total;
      lines.push(`• ${p.name}: ${money(b.total)} ${CUR} (${b.vm_count} máy, ${Math.round(b.vm_hours)} giờ)`);
      if (b.top[0]?.cost > 0) lines.push(`   tốn nhất: ${b.top[0].name} — ${money(b.top[0].cost)} ${CUR}`);
      pushNotice({ project_id: p.id, project_name: p.name, level: 'info', title: `Báo cáo chi phí tháng ${label}`, detail: `Tổng ${money(b.total)} ${CUR} · compute ${money(b.compute)} · storage ${money(b.storage)} · network ${money(b.network)}`, link: '/usage' });
    } catch (e) { lines.push(`• ${p.name}: không tính được (${e.message})`); }
  }
  lines.push('', `TỔNG CỘNG: ${money(grand)} ${CUR}`);
  notify(lines.join('\n'));
  console.log(`[report] Đã gửi báo cáo chi phí tháng ${label} (${projects.length} project)`);
}

async function tick() {
  const np = nowParts();
  if (Number(np.day) !== DAY || np.hour !== HOUR || np.minute > 5) return;
  const slot = `${np.year}-${np.month}`;
  if (sent.last === slot) return;
  sent.last = slot;
  saveJson('report-sent.json', sent);
  await sendMonthly();
}

export function startReport() {
  if (!DAY) return;
  if (!svcConfigured() || !telegramEnabled()) {
    console.log('[report] Báo cáo chi phí định kỳ tắt (cần OS_TASK_* và TELEGRAM_*)');
    return;
  }
  setInterval(() => tick().catch((e) => console.warn('[report] lỗi:', e.message)), 5 * 60000);
  console.log(`[report] Báo cáo chi phí sẽ gửi Telegram ngày ${DAY} hàng tháng lúc ${HOUR}:00 (${SCHED_TZ})`);
}
export { sendMonthly };
