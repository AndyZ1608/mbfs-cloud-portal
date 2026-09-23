// monitor.js — Giám sát VM tích hợp, không cần Ceilometer/agent.
// Vòng lặp nền dùng tài khoản dịch vụ đọc Nova os-diagnostics (libvirt trên
// hypervisor) → tính CPU% (delta cpu-time), RAM, tốc độ mạng/đĩa (delta counter)
// → lưu ring buffer trong RAM + DATA_DIR/metrics.json (giữ 24h mặc định).
// LƯU Ý QUYỀN: os-diagnostics mặc định admin-only — xem INSTALL.md.
import { osFetch } from './openstack.js';
import { getServiceSession, getServiceProjects, svcConfigured } from './svcauth.js';
import { loadJson, saveJson } from './store.js';
import { notify, telegramEnabled } from './alerts.js';
import { pushNotice } from './notify.js';

const INTERVAL = Math.max(30, Number(process.env.MONITOR_INTERVAL_SEC) || 120) * 1000;
const RETENTION = Math.max(1, Number(process.env.MONITOR_RETENTION_H) || 24) * 3600000;
const CPU_TH = Number(process.env.ALERT_CPU_PCT ?? 90); // 0 = tắt cảnh báo CPU
const URL_TPL = process.env.MONITOR_URL_TEMPLATE || '';

// series: id -> { name, project_id, samples: [[ts,cpu,memU,memM,rx,tx,rd,wr],...] }
const persisted = loadJson('metrics.json', { series: {} });
const series = new Map(Object.entries(persisted.series || {}));
const lastRaw = new Map();   // id -> { t, cpu_ns, num_cpus, rx, tx, rd, wr }
const cpuAlert = new Map();  // id -> ts lần báo gần nhất
let loops = 0;
let permWarned = false;

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Parse cả 2 dạng diagnostics: microversion >=2.48 (chuẩn hoá) và legacy libvirt dict
function parseDiag(d) {
  if (d.cpu_details || d.nic_details || d.disk_details) {
    const sum = (arr, k) => (arr || []).reduce((a, x) => a + (Number(x[k]) || 0), 0);
    return {
      cpu_ns: sum(d.cpu_details, 'time'),
      num_cpus: d.num_cpus || (d.cpu_details || []).length || 1,
      memU: d.memory_details?.used ?? null,     // MiB
      memM: d.memory_details?.maximum ?? null,  // MiB
      rx: sum(d.nic_details, 'rx_octets'), tx: sum(d.nic_details, 'tx_octets'),
      rd: sum(d.disk_details, 'read_bytes'), wr: sum(d.disk_details, 'write_bytes'),
    };
  }
  // legacy: { cpu0_time, vda_read, vnet0_rx, memory-rss (KiB), memory (KiB) ... }
  let cpu_ns = 0, cpus = 0, rx = 0, tx = 0, rd = 0, wr = 0;
  for (const [k, v] of Object.entries(d)) {
    if (/^cpu\d+_time$/.test(k)) { cpu_ns += Number(v) || 0; cpus++; }
    else if (/_rx$/.test(k)) rx += Number(v) || 0;
    else if (/_tx$/.test(k)) tx += Number(v) || 0;
    else if (/_read$/.test(k)) rd += Number(v) || 0;
    else if (/_write$/.test(k)) wr += Number(v) || 0;
  }
  return {
    cpu_ns, num_cpus: cpus || 1,
    memU: d['memory-rss'] ? Math.round(d['memory-rss'] / 1024) : null,
    memM: d.memory ? Math.round(d.memory / 1024) : null,
    rx, tx, rd, wr,
  };
}

async function sampleServer(sess, s) {
  let diag;
  try {
    diag = await osFetch(sess, 'compute', `/servers/${s.id}/diagnostics`);
  } catch (e) {
    if (e.status === 403 && !permWarned) {
      permWarned = true;
      console.warn('[monitor] Nova từ chối os-diagnostics (403) — tài khoản dịch vụ cần role admin hoặc sửa policy Nova (xem INSTALL.md mục Giám sát)');
    }
    return;
  }
  const now = Date.now();
  const cur = parseDiag(diag);
  const prev = lastRaw.get(s.id);
  lastRaw.set(s.id, { t: now, ...cur });
  if (!prev || now <= prev.t) return; // cần 2 mẫu mới tính được delta

  const dtS = (now - prev.t) / 1000;
  if (dtS < 5) return; // hai lần lấy mẫu quá sát nhau → tỉ lệ tính ra vô nghĩa
  const cpu = Math.min(100, Math.max(0, ((cur.cpu_ns - prev.cpu_ns) / 1e9 / dtS / cur.num_cpus) * 100));
  const rate = (a, b) => Math.max(0, (a - b) / dtS); // bytes/s
  const sample = [now, r1(cpu), cur.memU, cur.memM,
    Math.round(rate(cur.rx, prev.rx)), Math.round(rate(cur.tx, prev.tx)),
    Math.round(rate(cur.rd, prev.rd)), Math.round(rate(cur.wr, prev.wr))];

  let e = series.get(s.id);
  if (!e) { e = { name: s.name, project_id: s.project_id || s.tenant_id, samples: [] }; series.set(s.id, e); }
  e.name = s.name;
  e.project_id = s.project_id || s.tenant_id || e.project_id;
  e.samples.push(sample);
  const cutoff = now - RETENTION;
  while (e.samples.length && e.samples[0][0] < cutoff) e.samples.shift();

  // Cảnh báo CPU cao kéo dài (3 mẫu liên tiếp)
  if (CPU_TH > 0 && telegramEnabled()) {
    const last3 = e.samples.slice(-3).map((x) => x[1]);
    if (last3.length === 3 && last3.every((c) => c >= CPU_TH)) {
      const last = cpuAlert.get(s.id) || 0;
      if (Date.now() - last > 6 * 3600000) {
        cpuAlert.set(s.id, Date.now());
        notify(`🔥 [MBFS Cloud] Máy ảo "${s.name}" CPU ${last3[2]}% (≥${CPU_TH}% liên tục ${Math.round((3 * INTERVAL) / 60000)} phút)`);
        pushNotice({ project_id: e.project_id, project_name: '', level: 'warn', title: `CPU cao: ${s.name}`, detail: `CPU ${last3[2]}% liên tục ${Math.round((3 * INTERVAL) / 60000)} phút`, link: '/instances', code: 'highCpu', values: { name: s.name, cpu: last3[2], minutes: Math.round((3 * INTERVAL) / 60000) } });
      }
    } else if (last3.length && last3[last3.length - 1] < CPU_TH - 10 && cpuAlert.has(s.id)) {
      cpuAlert.delete(s.id);
      notify(`✅ [MBFS Cloud] Máy ảo "${s.name}" CPU đã hạ về ${last3[last3.length - 1]}%`);
    }
  }
}

async function sweep() {
  const projects = await getServiceProjects();
  const seen = new Set();
  const sampled = new Set(); // mỗi máy chỉ lấy mẫu 1 lần/vòng quét
  for (const p of projects) {
    try {
      const sess = await getServiceSession(p.id);
      const servers = (await osFetch(sess, 'compute', '/servers/detail?limit=1000')).servers || [];
      for (const s of servers) {
        seen.add(s.id);
        if (s.status !== 'ACTIVE' || sampled.has(s.id)) continue;
        sampled.add(s.id);
        s.project_id = p.id;
        await sampleServer(sess, s);
      }
    } catch (e) { console.warn(`[monitor] project ${p.name}: ${e.message}`); }
  }
  // VM đã xoá → giữ series tới hết retention rồi tự trôi; dọn entry rỗng
  for (const [id, e] of series) {
    if (!seen.has(id) && (!e.samples.length || e.samples[e.samples.length - 1][0] < Date.now() - RETENTION)) series.delete(id);
    if (!e.samples.length) series.delete(id);
  }
  if (++loops % 5 === 0) saveJson('metrics.json', { series: Object.fromEntries(series) });
}

export function startMonitor() {
  if (!svcConfigured()) { console.log('[monitor] Tắt — chưa cấu hình OS_TASK_USERNAME/OS_TASK_PASSWORD'); return; }
  setInterval(() => sweep().catch((e) => console.warn('[monitor] sweep lỗi:', e.message)), INTERVAL);
  sweep().catch(() => {});
  console.log(`[monitor] Giám sát VM bật — lấy mẫu mỗi ${INTERVAL / 1000}s, giữ ${RETENTION / 3600000}h, cảnh báo CPU ${CPU_TH > 0 ? '≥' + CPU_TH + '%' : 'tắt'}`);
}

export const monitorStatus = () => ({
  enabled: svcConfigured(),
  interval_sec: INTERVAL / 1000,
  retention_h: RETENTION / 3600000,
  cpu_alert_pct: CPU_TH,
  url_template: URL_TPL,
});

export function latestFor(projectId) {
  const out = {};
  for (const [id, e] of series) {
    if (e.project_id !== projectId || !e.samples.length) continue;
    const s = e.samples[e.samples.length - 1];
    out[id] = { ts: s[0], cpu: s[1], mem_pct: s[2] != null && s[3] ? Math.round((s[2] / s[3]) * 100) : null };
  }
  return out;
}

// Thống kê CPU cho trang Tối ưu tài nguyên: {id: {avg, max, samples, hours}}
export function cpuStats(projectId, hours = 168) {
  const cutoff = Date.now() - hours * 3600000;
  const out = {};
  for (const [id, e] of series) {
    if (e.project_id !== projectId) continue;
    const pts = e.samples.filter((s) => s[0] >= cutoff && s[1] != null);
    if (pts.length < 3) continue;
    const cpu = pts.map((s) => s[1]);
    out[id] = {
      avg: Math.round((cpu.reduce((a, b) => a + b, 0) / cpu.length) * 10) / 10,
      max: Math.round(Math.max(...cpu) * 10) / 10,
      samples: pts.length,
      span_h: Math.round(((pts[pts.length - 1][0] - pts[0][0]) / 3600000) * 10) / 10,
    };
  }
  return out;
}

export function seriesFor(projectId, serverId, hours = 24) {
  const e = series.get(serverId);
  if (!e || e.project_id !== projectId) return null;
  const cutoff = Date.now() - Math.min(hours, RETENTION / 3600000) * 3600000;
  return { name: e.name, samples: e.samples.filter((s) => s[0] >= cutoff) };
}
