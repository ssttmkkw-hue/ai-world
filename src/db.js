// SQLite 存储：当前格子、append-only 改动日志、快照、幂等记录、元数据。
// 使用 Node 内置 node:sqlite（无需原生编译）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS cells (
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  c INTEGER, o TEXT, t TEXT,
  by TEXT, v INTEGER NOT NULL,
  PRIMARY KEY (x, y)
);
CREATE TABLE IF NOT EXISTS acts (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  by TEXT NOT NULL,
  intent TEXT NOT NULL,
  n_ops INTEGER NOT NULL,
  ops TEXT NOT NULL,      -- 请求中的 op（JSON）
  changes TEXT NOT NULL   -- [{x,y,before:{c,o,t,by,v},after:{...}}]（JSON）
);
CREATE INDEX IF NOT EXISTS acts_by_ts ON acts (by, ts);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  reason TEXT NOT NULL,
  cells TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  agent TEXT NOT NULL, key TEXT NOT NULL,
  req_hash TEXT NOT NULL, response TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (agent, key)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      allCells: p('SELECT x, y, c, o, t, by, v FROM cells'),
      upsertCell: p(`INSERT INTO cells (x, y, c, o, t, by, v) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (x, y) DO UPDATE SET c = excluded.c, o = excluded.o, t = excluded.t, by = excluded.by, v = excluded.v`),
      maxSeq: p('SELECT COALESCE(MAX(seq), 0) AS s FROM acts'),
      insertAct: p('INSERT INTO acts (seq, ts, by, intent, n_ops, ops, changes) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      recent: p('SELECT seq, ts, by, intent, n_ops, changes FROM acts ORDER BY seq DESC LIMIT ?'),
      usage: p('SELECT COUNT(*) AS acts, COALESCE(SUM(n_ops), 0) AS ops FROM acts WHERE by = ? AND ts > ?'),
      actsSince: p('SELECT COUNT(*) AS n FROM acts WHERE by = ? AND ts > ?'),
      oldestSince: p('SELECT MIN(ts) AS ts FROM acts WHERE by = ? AND ts > ?'),
      insertSnap: p('INSERT INTO snapshots (seq, ts, reason, cells) VALUES (?, ?, ?, ?)'),
      listSnaps: p('SELECT id, seq, ts, reason FROM snapshots ORDER BY id DESC LIMIT ?'),
      getSnap: p('SELECT id, seq, ts, reason, cells FROM snapshots WHERE id = ?'),
      getIdem: p('SELECT req_hash, response FROM idempotency WHERE agent = ? AND key = ?'),
      putIdem: p('INSERT INTO idempotency (agent, key, req_hash, response, ts) VALUES (?, ?, ?, ?, ?)'),
      pruneIdem: p('DELETE FROM idempotency WHERE ts < ?'),
      getMeta: p('SELECT v FROM meta WHERE k = ?'),
      setMeta: p('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(k, d = null) {
    const r = this.q.getMeta.get(k);
    return r ? JSON.parse(r.v) : d;
  }

  setMeta(k, v) {
    this.q.setMeta.run(k, JSON.stringify(v));
  }

  close() {
    this.db.close();
  }
}
