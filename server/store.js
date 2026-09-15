// store.js — lưu trữ nhẹ cho policies / audit / alert-state (không cần DB)
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || '/data';

let writable = true;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch {
  writable = false;
  console.warn(`[store] DATA_DIR=${DATA_DIR} không ghi được → policies/audit chỉ nằm trong RAM (mất khi restart). Mount volume vào ${DATA_DIR} để lưu bền.`);
}
export const persistent = () => writable;

export function loadJson(name, def) {
  if (!writable) return def;
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return def; }
}

export function saveJson(name, obj) {
  if (!writable) return;
  try {
    const f = path.join(DATA_DIR, name);
    fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1));
    fs.renameSync(f + '.tmp', f);
  } catch (e) { console.warn(`[store] Không ghi được ${name}: ${e.message}`); }
}

// JSONL append có xoay vòng (giữ file gọn)
export function appendJsonl(name, obj, maxBytes = 2 * 1024 * 1024) {
  if (!writable) return;
  try {
    const f = path.join(DATA_DIR, name);
    try { if (fs.statSync(f).size > maxBytes) fs.renameSync(f, f + '.1'); } catch { /* chưa có file */ }
    fs.appendFileSync(f, JSON.stringify(obj) + '\n');
  } catch (e) { console.warn(`[store] Không ghi được ${name}: ${e.message}`); }
}

export function readJsonlTail(name, maxLines = 5000) {
  if (!writable) return [];
  const out = [];
  for (const suffix of ['.1', '']) {
    try {
      const lines = fs.readFileSync(path.join(DATA_DIR, name + suffix), 'utf8').split('\n');
      for (const l of lines) { if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* dòng hỏng */ } } }
    } catch { /* không có file */ }
  }
  return out.slice(-maxLines);
}
