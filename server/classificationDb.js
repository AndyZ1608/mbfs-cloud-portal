import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './store.js';

const migrations = [
  './migrations/001_classifications.up.sql',
  './migrations/002_sso_identity_bindings.up.sql',
].map((name) => fileURLToPath(new URL(name, import.meta.url)));
let singleton;

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function openClassificationDb(location = path.join(DATA_DIR, 'classifications.sqlite')) {
  // Fail closed if persistent storage is unavailable; never silently store classifications in RAM.
  if (location !== ':memory:') fs.mkdirSync(path.dirname(location), { recursive: true });
  const db = new DatabaseSync(location);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT');
  transaction(db, () => {
    for (const [index, migration] of migrations.entries()) {
      const version = index + 1;
      if (db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version)) continue;
      db.exec(fs.readFileSync(migration, 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(version, new Date().toISOString());
    }
  });
  return db;
}

export function classificationDb() { return singleton ||= openClassificationDb(); }
export function closeClassificationDb() { singleton?.close(); singleton = undefined; }
