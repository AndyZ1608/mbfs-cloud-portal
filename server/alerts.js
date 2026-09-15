// alerts.js — Cảnh báo Telegram: quota vượt ngưỡng, máy ảo ERROR, LB suy giảm.
// Dùng tài khoản dịch vụ OS_TASK_*; quét mọi project mà tài khoản đó có quyền.
// Chống spam: mỗi sự cố chỉ nhắc lại sau ALERT_REPEAT_HOURS; có tin "đã phục hồi".
import { osFetch } from './openstack.js';
import { getServiceSession, getServiceProjects, svcConfigured } from './svcauth.js';
import { loadJson, saveJson } from './store.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const THRESHOLD = Number(process.env.ALERT_QUOTA_PCT) || 85;
const INTERVAL_MIN = Number(process.env.ALERT_INTERVAL_MIN) || 5;
const REPEAT_MS = (Number(process.env.ALERT_REPEAT_HOURS) || 6) * 3600000;

let state = loadJson('alerts-state.json', {}); // key -> ts lần báo gần nhất

async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.warn('[alerts] Telegram trả lỗi', res.status, (await res.text()).slice(0, 120));
  } catch (e) { console.warn('[alerts] Không gửi được Telegram:', e.message); }
}

export const telegramEnabled = () => !!(TOKEN && CHAT);
export function notify(text) { if (telegramEnabled()) sendTelegram(text); }

function fire(key, text) {
  const last = state[key];
  if (last && Date.now() - last < REPEAT_MS) return;
  state[key] = Date.now();
  sendTelegram(text);
}
function recover(key, text) {
  if (!state[key]) return;
  delete state[key];
  sendTelegram(text);
}

async function checkProject(p) {
  const sess = await getServiceSession(p.id);
  const tag = `[MBFS Cloud] Project ${p.name}`;

  // --- Quota ---
  const [novaR, cinR, neuR] = await Promise.allSettled([
    osFetch(sess, 'compute', '/limits'),
    osFetch(sess, 'volume', '/limits'),
    osFetch(sess, 'network', `/v2.0/quotas/${p.id}/details.json`),
  ]);
  const checks = [];
  if (novaR.status === 'fulfilled') {
    const a = novaR.value?.limits?.absolute || {};
    checks.push(['vCPU', a.totalCoresUsed, a.maxTotalCores]);
    checks.push(['RAM (MB)', a.totalRAMUsed, a.maxTotalRAMSize]);
    checks.push(['Máy ảo', a.totalInstancesUsed, a.maxTotalInstances]);
  }
  if (cinR.status === 'fulfilled') {
    const a = cinR.value?.limits?.absolute || {};
    checks.push(['Dung lượng volume (GB)', a.totalGigabytesUsed, a.maxTotalVolumeGigabytes]);
    checks.push(['Số volume', a.totalVolumesUsed, a.maxTotalVolumes]);
  }
  if (neuR.status === 'fulfilled') {
    const q = neuR.value?.quota || {};
    if (q.floatingip) checks.push(['Floating IP', q.floatingip.used, q.floatingip.limit]);
  }
  for (const [label, used, max] of checks) {
    if (!(max > 0)) continue;
    const pct = Math.round((used / max) * 100);
    const key = `q:${p.id}:${label}`;
    if (pct >= THRESHOLD) fire(key, `⚠️ ${tag}\nQuota ${label} đạt ${pct}% (${used}/${max})`);
    else if (pct < THRESHOLD - 5) recover(key, `✅ ${tag}\nQuota ${label} về ${pct}% (${used}/${max}) — hết cảnh báo`);
  }

  // --- Máy ảo ERROR ---
  try {
    const servers = (await osFetch(sess, 'compute', '/servers/detail?limit=1000')).servers || [];
    const errIds = new Set();
    for (const s of servers) {
      if (s.status === 'ERROR') {
        errIds.add(s.id);
        fire(`vm:${s.id}`, `🔴 ${tag}\nMáy ảo "${s.name}" đang ERROR${s.fault?.message ? `\n${s.fault.message.slice(0, 150)}` : ''}`);
      }
    }
    for (const key of Object.keys(state)) {
      if (key.startsWith('vm:') && !errIds.has(key.slice(3))) {
        const stillHere = servers.find((s) => s.id === key.slice(3));
        recover(key, `✅ ${tag}\nMáy ảo "${stillHere?.name || key.slice(3, 11)}" ${stillHere ? 'đã hết ERROR' : 'đã được xoá'}`);
      }
    }
  } catch { /* nova lỗi tạm thời */ }

  // --- Load balancer suy giảm ---
  try {
    const lbs = (await osFetch(sess, 'lb', '/v2/lbaas/loadbalancers')).loadbalancers || [];
    for (const lb of lbs) {
      const key = `lb:${lb.id}`;
      if (['ERROR', 'DEGRADED', 'OFFLINE'].includes(lb.operating_status) && lb.provisioning_status === 'ACTIVE') {
        fire(key, `🟠 ${tag}\nLoad balancer "${lb.name}" đang ${lb.operating_status} (VIP ${lb.vip_address})`);
      } else if (lb.operating_status === 'ONLINE') {
        recover(key, `✅ ${tag}\nLoad balancer "${lb.name}" đã ONLINE trở lại`);
      }
    }
  } catch { /* cụm không có Octavia */ }
}

async function sweep() {
  const projects = await getServiceProjects();
  for (const p of projects) {
    try { await checkProject(p); }
    catch (e) { console.warn(`[alerts] project ${p.name}: ${e.message}`); }
  }
  saveJson('alerts-state.json', state);
}

export function startAlerts() {
  if (!TOKEN || !CHAT) { console.log('[alerts] Telegram tắt (thiếu TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)'); return; }
  if (!svcConfigured()) { console.log('[alerts] Telegram tắt (thiếu OS_TASK_USERNAME/OS_TASK_PASSWORD)'); return; }
  setInterval(() => sweep().catch((e) => console.warn('[alerts] sweep lỗi:', e.message)), INTERVAL_MIN * 60000);
  console.log(`[alerts] Cảnh báo Telegram bật — ngưỡng quota ${THRESHOLD}%, quét mỗi ${INTERVAL_MIN} phút`);
  sweep().catch(() => {});
}
