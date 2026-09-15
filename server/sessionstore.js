// sessionstore.js — Lưu phiên đăng nhập bền vững, KHÔNG dùng thư viện ngoài.
//  · SESSION_STORE=redis → client RESP tự viết (chạy nhiều replica được, HA)
//  · SESSION_STORE=file  → lưu JSON trong DATA_DIR (restart không mất phiên)
//  · mặc định            → bộ nhớ RAM như cũ
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import session from 'express-session';
import { DATA_DIR } from './store.js';

const Store = session.Store;

// ---------- Redis client tối giản (RESP2) ----------
class Redis {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = Number(u.port) || 6379;
    this.pass = u.password || process.env.REDIS_PASSWORD || '';
    this.db = u.pathname && u.pathname !== '/' ? u.pathname.slice(1) : null;
    this.queue = []; this.buf = Buffer.alloc(0); this.sock = null; this.ready = false;
    this.connect();
  }
  connect() {
    this.sock = net.createConnection({ host: this.host, port: this.port });
    this.sock.setNoDelay(true);
    this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    this.sock.on('error', (e) => { console.warn('[session] Redis lỗi:', e.message); this.fail(e); });
    this.sock.on('close', () => { this.ready = false; this.fail(new Error('Mất kết nối Redis')); setTimeout(() => this.connect(), 2000); });
    this.sock.on('connect', async () => {
      this.ready = true;
      try {
        if (this.pass) await this.cmd('AUTH', this.pass);
        if (this.db) await this.cmd('SELECT', this.db);
        console.log(`[session] Đã kết nối Redis ${this.host}:${this.port}`);
      } catch (e) { console.warn('[session] Redis auth lỗi:', e.message); }
    });
  }
  fail(err) { const q = this.queue; this.queue = []; q.forEach(({ reject }) => reject(err)); }
  cmd(...args) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('Redis chưa sẵn sàng'));
      this.queue.push({ resolve, reject });
      let out = `*${args.length}\r\n`;
      for (const a of args) { const s = String(a); out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
      this.sock.write(out);
    });
  }
  // Parse một reply; trả [value, bytesConsumed] hoặc null nếu chưa đủ dữ liệu
  parse(buf, i = 0) {
    if (i >= buf.length) return null;
    const type = buf[i];
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) return null;
    const line = buf.slice(i + 1, nl).toString();
    if (type === 43 || type === 58) return [type === 58 ? Number(line) : line, nl + 2];       // + simple, : int
    if (type === 45) return [new Error(line), nl + 2];                                        // - error
    if (type === 36) {                                                                        // $ bulk
      const len = Number(line);
      if (len === -1) return [null, nl + 2];
      if (buf.length < nl + 2 + len + 2) return null;
      return [buf.slice(nl + 2, nl + 2 + len).toString(), nl + 2 + len + 2];
    }
    if (type === 42) {                                                                        // * array
      const n = Number(line);
      if (n === -1) return [null, nl + 2];
      const arr = []; let p = nl + 2;
      for (let k = 0; k < n; k++) {
        const r = this.parse(buf, p);
        if (!r) return null;
        arr.push(r[0]); p = r[1];
      }
      return [arr, p];
    }
    return null;
  }
  drain() {
    for (;;) {
      const r = this.parse(this.buf, 0);
      if (!r) return;
      this.buf = this.buf.slice(r[1]);
      const w = this.queue.shift();
      if (!w) continue;
      r[0] instanceof Error ? w.reject(r[0]) : w.resolve(r[0]);
    }
  }
}

class RedisStore extends Store {
  constructor(url, ttlSec) { super(); this.r = new Redis(url); this.ttl = ttlSec; this.prefix = process.env.REDIS_PREFIX || 'mbfs:sess:'; }
  get(sid, cb) {
    this.r.cmd('GET', this.prefix + sid)
      .then((v) => cb(null, v ? JSON.parse(v) : null))
      .catch((e) => cb(e));
  }
  set(sid, sess, cb) {
    this.r.cmd('SET', this.prefix + sid, JSON.stringify(sess), 'EX', String(this.ttl))
      .then(() => cb(null)).catch((e) => cb(e));
  }
  destroy(sid, cb) { this.r.cmd('DEL', this.prefix + sid).then(() => cb(null)).catch((e) => cb(e)); }
  touch(sid, sess, cb) { this.r.cmd('EXPIRE', this.prefix + sid, String(this.ttl)).then(() => cb(null)).catch(() => cb(null)); }
}

// ---------- File store ----------
class FileStore extends Store {
  constructor(dir, ttlSec) {
    super();
    this.dir = path.join(dir, 'sessions');
    this.ttl = ttlSec * 1000;
    fs.mkdirSync(this.dir, { recursive: true });
    setInterval(() => this.sweep(), 15 * 60000).unref?.();
  }
  file(sid) { return path.join(this.dir, encodeURIComponent(sid) + '.json'); }
  get(sid, cb) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(sid), 'utf8'));
      if (raw.__exp < Date.now()) { fs.unlinkSync(this.file(sid)); return cb(null, null); }
      cb(null, raw.data);
    } catch { cb(null, null); }
  }
  set(sid, sess, cb) {
    try { fs.writeFileSync(this.file(sid), JSON.stringify({ __exp: Date.now() + this.ttl, data: sess })); cb(null); }
    catch (e) { cb(e); }
  }
  destroy(sid, cb) { try { fs.unlinkSync(this.file(sid)); } catch { /* đã xoá */ } cb(null); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  sweep() {
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const p = path.join(this.dir, f);
        try { if (JSON.parse(fs.readFileSync(p, 'utf8')).__exp < Date.now()) fs.unlinkSync(p); } catch { fs.unlinkSync(p); }
      }
    } catch { /* bỏ qua */ }
  }
}

export function buildSessionStore(ttlSec) {
  const kind = (process.env.SESSION_STORE || 'memory').toLowerCase();
  if (kind === 'redis') {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    console.log(`[session] Dùng Redis (${url.replace(/:[^:@/]*@/, ':***@')}) — chạy nhiều replica được`);
    return new RedisStore(url, ttlSec);
  }
  if (kind === 'file') {
    console.log(`[session] Dùng file trong ${DATA_DIR}/sessions — restart không mất phiên`);
    return new FileStore(DATA_DIR, ttlSec);
  }
  console.log('[session] Dùng bộ nhớ RAM — restart là mất phiên, chỉ chạy 1 replica');
  return undefined;
}
export { Redis, RedisStore, FileStore };
