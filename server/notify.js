// notify.js — Trung tâm thông báo trong portal (backup, lịch bật/tắt, cảnh báo…)
import { appendJsonl, readJsonlTail, loadJson, saveJson } from './store.js';

const MAX = 500;
const MEM = readJsonlTail('notifications.jsonl', MAX);
let readState = loadJson('notify-read.json', {}); // "user@project" -> ts đọc gần nhất

export function pushNotice({ project_id, project_name, level = 'info', title, detail = '', link = '', code, values }) {
  const n = { id: crypto.randomUUID(), ts: new Date().toISOString(), project_id, project_name, level, title, detail, link };
  if (code) n.code = code;
  if (values) n.values = values;
  MEM.push(n);
  if (MEM.length > MAX) MEM.shift();
  appendJsonl('notifications.jsonl', n);
  return n;
}

export function listNotices(projectId, limit = 50) {
  const out = [];
  for (let i = MEM.length - 1; i >= 0 && out.length < limit; i--) {
    if (MEM[i].project_id === projectId) out.push(MEM[i]);
  }
  return out;
}

const key = (u, p) => `${u}@${p}`;
export function unreadCount(user, projectId) {
  const since = readState[key(user, projectId)] || 0;
  return listNotices(projectId, MAX).filter((n) => Date.parse(n.ts) > since).length;
}
export function markRead(user, projectId) {
  readState[key(user, projectId)] = Date.now();
  saveJson('notify-read.json', readState);
}
