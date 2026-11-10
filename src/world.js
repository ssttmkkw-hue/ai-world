// 世界核心：内存棋盘 + 串行原子写入 + 先落库再广播。
// Node 单线程 + act() 全程同步，所以写入天然串行。
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WIDTH, HEIGHT, RECENT_DEFAULT, RECENT_MAX, MAX_INTENT_LEN } from './config.js';
import { validateAct, cleanText } from './validate.js';

const IDEM_TTL_MS = 24 * 3600 * 1000;
const idx = (x, y) => y * WIDTH + x;
const EMPTY = Object.freeze({ c: null, o: null, t: null, by: null, v: 0 });

export class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(body.error);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export class World extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./db.js').Store} o.store
   * @param {import('./secrets.js').Auth} o.auth
   * @param {object} o.config  loadConfig() 的结果
   * @param {() => number} [o.now]
   */
  constructor({ store, auth, config, now = Date.now }) {
    super();
    this.setMaxListeners(0);
    this.store = store;
    this.auth = auth;
    this.config = config;
    this.now = now;
    this.cells = new Array(WIDTH * HEIGHT).fill(EMPTY);
    for (const r of store.q.allCells.all()) {
      this.cells[idx(r.x, r.y)] = { c: r.c, o: r.o, t: r.t, by: r.by, v: r.v };
    }
    this.seq = store.q.maxSeq.get().s;
    this.paused = store.getMeta('paused', { paused: false, reason: '' });
    this.theme = store.getMeta('theme', null) ?? config.theme;
    // 自动快照计数从库里推算，重启不清零
    this.lastSnapshotSeq = store.q.lastSnapSeq.get().s;
    // 版本号：seq 或状态变化时递增，供读接口缓存
    this.version = 0;
  }

  // ---------- 读取 ----------

  cell(x, y) {
    return this.cells[idx(x, y)];
  }

  /** 所有被写过的格子（v>0），稀疏列表。 */
  sparseCells() {
    const out = [];
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const c = this.cells[idx(x, y)];
        if (c.v > 0) out.push({ x, y, ...c });
      }
    }
    return out;
  }

  recent(limit = RECENT_DEFAULT) {
    const n = Math.min(Math.max(1, limit | 0 || RECENT_DEFAULT), RECENT_MAX);
    return this.store.q.recent.all(n).map((r) => {
      const changes = JSON.parse(r.changes);
      return {
        seq: r.seq,
        ts: r.ts,
        by: r.by,
        name: this.auth.name(r.by),
        intent: r.intent,
        n_ops: r.n_ops,
        cells: changes.slice(0, 64).map((c) => [c.x, c.y]),
      };
    });
  }

  status() {
    return { seq: this.seq, paused: this.paused.paused, pause_reason: this.paused.reason, theme: this.theme };
  }

  snapshotMessage() {
    return { type: 'snapshot', ...this.status(), width: WIDTH, height: HEIGHT, cells: this.sparseCells(), recent: this.recent() };
  }

  usage(agentId) {
    const now = this.now();
    const minute = this.store.q.usage.get(agentId, now - 60_000);
    const hour = this.store.q.usage.get(agentId, now - 3_600_000);
    return {
      acts_last_minute: minute.acts,
      ops_last_hour: hour.ops,
      acts_per_minute_limit: this.config.ratePerMinute,
      ops_per_hour_limit: this.config.opsPerHour,
    };
  }

  // ---------- 写入 ----------

  /**
   * 执行一次 act。成功返回 { status, body }；失败抛 HttpError。
   * 顺序：暂停 → 幂等回放 → 校验 → 限频 → if_v → 落库 → 广播。
   */
  act(agent, idemKey, body) {
    if (typeof idemKey !== 'string' || !idemKey.trim()) {
      throw new HttpError(400, { error: 'idempotency_key_required', message: 'send an Idempotency-Key header (any unique string per action)' });
    }
    if (idemKey.length > 128) throw new HttpError(400, { error: 'idempotency_key_too_long' });

    const reqHash = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
    const now = this.now();
    let prev = this.store.q.getIdem.get(agent.id, idemKey);
    const expired = !!prev && prev.ts <= now - IDEM_TTL_MS; // 过期的 key 当作不存在
    if (expired) prev = null;
    if (prev) {
      if (prev.req_hash !== reqHash) {
        throw new HttpError(422, { error: 'idempotency_key_reused', message: 'this Idempotency-Key was used with a different body' });
      }
      return { status: 200, body: { ...JSON.parse(prev.response), replayed: true } };
    }

    if (this.paused.paused) {
      throw new HttpError(503, { error: 'paused', message: this.paused.reason || 'the world is paused by the admin' });
    }

    const v = validateAct(body, { blocklist: this.config.blocklist });
    if (v.errors) throw new HttpError(400, { error: 'invalid', details: v.errors });

    const used = this.#checkRate(agent.id, v.ops.length);

    // 可选乐观锁：if_v 与 act 开始时格子的 v 比较
    const conflicts = [];
    v.ops.forEach((op, i) => {
      if (op.if_v !== undefined) {
        const cur = this.cell(op.x, op.y).v;
        if (cur !== op.if_v) conflicts.push({ i, x: op.x, y: op.y, if_v: op.if_v, v: cur });
      }
    });
    if (conflicts.length) {
      throw new HttpError(409, { error: 'conflict', message: 'cell changed since you read it; re-read the board', conflicts });
    }

    const seq = this.seq + 1;
    const ts = now;
    const working = new Map(); // idx -> cell（act 内的工作副本）
    const results = [];
    for (const op of v.ops) {
      const k = idx(op.x, op.y);
      const before = working.get(k) ?? this.cells[k];
      const after = { ...before, by: agent.id, v: seq };
      if (op.op === 'paint') after.c = op.color;
      else if (op.op === 'place') after.o = op.object;
      else if (op.op === 'write') after.t = op.text;
      else if (op.op === 'clear') {
        if (op.layer === 'color' || op.layer === 'all') after.c = null;
        if (op.layer === 'object' || op.layer === 'all') after.o = null;
        if (op.layer === 'text' || op.layer === 'all') after.t = null;
      }
      working.set(k, after);
      results.push({ op: op.op, x: op.x, y: op.y, old: before, new: after });
    }

    // 响应（含 usage）在提交前就确定，和棋盘、日志一起在同一个事务里存入幂等表。
    const response = {
      ok: true, seq, by: agent.id, intent: v.intent, results,
      usage: {
        acts_last_minute: used.acts + 1,
        ops_last_hour: used.ops + v.ops.length,
        acts_per_minute_limit: this.config.ratePerMinute,
        ops_per_hour_limit: this.config.opsPerHour,
      },
    };
    this.#commit({
      seq, ts, by: agent.id, intent: v.intent, ops: v.ops, working,
      inTx: () => {
        if (expired) this.store.q.delIdem.run(agent.id, idemKey);
        this.store.q.putIdem.run(agent.id, idemKey, reqHash, JSON.stringify(response), ts);
        this.store.q.pruneIdem.run(ts - IDEM_TTL_MS);
      },
    });
    return { status: 200, body: response };
  }

  #checkRate(agentId, nOps) {
    const now = this.now();
    const { ratePerMinute, opsPerHour } = this.config;
    const minute = this.store.q.usage.get(agentId, now - 60_000);
    if (minute.acts >= ratePerMinute) {
      const oldest = this.store.q.oldestSince.get(agentId, now - 60_000).ts ?? now;
      const retry = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
      throw new HttpError(429, { error: 'rate_limited', message: `max ${ratePerMinute} acts per minute`, retry_after: retry }, { 'retry-after': String(retry) });
    }
    const hour = this.store.q.usage.get(agentId, now - 3_600_000);
    if (hour.ops + nOps > opsPerHour) {
      const oldest = this.store.q.oldestSince.get(agentId, now - 3_600_000).ts ?? now;
      const retry = Math.max(1, Math.ceil((oldest + 3_600_000 - now) / 1000));
      throw new HttpError(429, {
        error: 'op_budget_exceeded',
        message: `max ${opsPerHour} ops per hour; used ${hour.ops}, requested ${nOps}`,
        retry_after: retry,
      }, { 'retry-after': String(retry) });
    }
    return { acts: minute.acts, ops: hour.ops };
  }

  /**
   * 落库（一个事务：格子 + 日志 + inTx 里的幂等记录）→ 更新内存 → 广播 → 自动快照。
   * 事务提交之后的步骤（广播、快照）失败不会把已成功的动作报告成失败。
   */
  #commit({ seq, ts, by, intent, ops, working, inTx }) {
    const changes = [];
    for (const [k, after] of working) {
      changes.push({ x: k % WIDTH, y: Math.floor(k / WIDTH), before: this.cells[k], after });
    }
    this.store.tx(() => {
      for (const ch of changes) {
        const a = ch.after;
        this.store.q.upsertCell.run(ch.x, ch.y, a.c, a.o, a.t, a.by, a.v);
      }
      this.store.q.insertAct.run(seq, ts, by, intent, ops.length, JSON.stringify(ops), JSON.stringify(changes));
      if (inTx) inTx();
    });
    for (const ch of changes) this.cells[idx(ch.x, ch.y)] = ch.after;
    this.seq = seq;
    this.version++;

    const cells = changes.map((ch) => ({ x: ch.x, y: ch.y, ...ch.after }));
    this.#safely('broadcast', () => this.emit('delta', { type: 'delta', seq, ts, by, name: this.auth.name(by), intent, cells }));

    const every = this.config.snapshotEveryActs;
    if (every > 0 && seq - this.lastSnapshotSeq >= every) {
      this.#safely('auto snapshot', () => this.snapshot('auto'));
    }
    return { ok: true, seq, by, intent };
  }

  #safely(what, fn) {
    try {
      fn();
    } catch (err) {
      this.emit('warn', `${what} failed after commit: ${err && err.message}`);
    }
  }

  // ---------- 管理 ----------

  setPaused(paused, reason = '') {
    const r = cleanText(reason || '', { max: MAX_INTENT_LEN, field: 'reason', allowEmpty: true });
    if (r.error) throw new HttpError(400, { error: 'invalid', message: r.error });
    this.paused = { paused: !!paused, reason: r.value };
    this.store.setMeta('paused', this.paused);
    this.version++;
    this.emit('status', { type: 'status', ...this.status() });
    return this.status();
  }

  setTheme(theme) {
    const r = cleanText(theme || '', { max: MAX_INTENT_LEN, field: 'theme', blocklist: this.config.blocklist, allowEmpty: true });
    if (r.error) throw new HttpError(400, { error: 'invalid', message: r.error });
    this.theme = r.value;
    this.store.setMeta('theme', this.theme);
    this.version++;
    this.emit('status', { type: 'status', ...this.status() });
    return this.status();
  }

  snapshot(reason = 'manual') {
    const cells = this.sparseCells();
    const info = this.store.q.insertSnap.run(this.seq, this.now(), String(reason).slice(0, 60), JSON.stringify(cells));
    this.lastSnapshotSeq = this.seq;
    return { id: Number(info.lastInsertRowid), seq: this.seq, cells: cells.length };
  }

  listSnapshots(limit = 50) {
    return this.store.q.listSnaps.all(Math.min(Math.max(1, limit | 0 || 50), 500));
  }

  /** 回滚到快照：把差异作为一次新的 act（by=admin）写入日志并广播，日志保持 append-only。 */
  rollback(snapshotId) {
    const snap = this.store.q.getSnap.get(snapshotId);
    if (!snap) throw new HttpError(404, { error: 'snapshot_not_found' });
    const target = new Map();
    for (const c of JSON.parse(snap.cells)) target.set(idx(c.x, c.y), c);
    const seq = this.seq + 1;
    const working = new Map();
    for (let k = 0; k < this.cells.length; k++) {
      const cur = this.cells[k];
      const t = target.get(k);
      const want = { c: t?.c ?? null, o: t?.o ?? null, t: t?.t ?? null };
      if (cur.c !== want.c || cur.o !== want.o || cur.t !== want.t) {
        working.set(k, { ...want, by: 'admin', v: seq });
      }
    }
    const intent = `rollback to snapshot #${snap.id} (seq ${snap.seq})`;
    if (working.size === 0) return { ok: true, seq: this.seq, changed: 0, intent };
    const res = this.#commit({ seq, ts: this.now(), by: 'admin', intent, ops: [{ op: 'rollback', snapshot: snap.id }], working });
    return { ...res, changed: working.size };
  }
}
