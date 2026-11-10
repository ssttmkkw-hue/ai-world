// 观众端棋盘同步状态机（不依赖 DOM，可在 Node 里测试）。
// 规则：
// - WS snapshot 是权威全量（WS 有序），总是采用，并作废进行中的 HTTP 重同步。
// - delta 只在 seq 正好接上时应用；断档时先缓存，启动「唯一一个」HTTP 重同步。
// - HTTP 结果只在没有被更新的快照取代、且 seq 不倒退时采用；采用后回放缓存中更新的 delta。
// - status 消息只更新暂停/主题，不推进 seq。

export class BoardSync {
  /**
   * @param {object} o
   * @param {() => Promise<object>} o.fetchBoard  返回 GET /v1/board 的 JSON
   * @param {(kind: 'full'|'delta'|'status', payload: object) => void} [o.onUpdate]
   * @param {(fn: () => void, ms: number) => unknown} [o.schedule]
   */
  constructor({ fetchBoard, onUpdate = () => {}, schedule = (fn, ms) => setTimeout(fn, ms) }) {
    this.fetchBoard = fetchBoard;
    this.onUpdate = onUpdate;
    this.schedule = schedule;
    this.seq = -1; // 还没有全量
    this.cells = new Map();
    this.status = { paused: false, pause_reason: '', theme: '' };
    this.pending = new Map(); // seq -> delta（断档期间缓存）
    this.syncing = null; // 进行中的 HTTP 重同步 Promise
    this.epoch = 0; // 每次采用 WS 快照 +1，用来丢弃过时的 HTTP 结果
    this.retryMs = 500;
    this.retryTimer = false;
  }

  static key(x, y) {
    return `${x},${y}`;
  }

  handle(msg) {
    if (msg.type === 'snapshot') {
      this.epoch++;
      this.#applyFull(msg);
    } else if (msg.type === 'delta') {
      this.#onDelta(msg);
    } else if (msg.type === 'status') {
      this.#applyStatus(msg);
      this.onUpdate('status', this.status);
    }
  }

  #applyStatus(s) {
    this.status = { paused: !!s.paused, pause_reason: s.pause_reason || '', theme: s.theme || '' };
  }

  #applyFull(b) {
    this.cells = new Map(b.cells.map((c) => [BoardSync.key(c.x, c.y), c]));
    this.seq = b.seq;
    this.#applyStatus(b);
    this.onUpdate('full', b);
    this.#drain();
  }

  #onDelta(d) {
    if (this.seq >= 0 && d.seq <= this.seq) return; // 旧消息
    if (this.seq >= 0 && d.seq === this.seq + 1 && !this.syncing) {
      this.#applyDelta(d);
      this.#drain();
      return;
    }
    this.pending.set(d.seq, d);
    if (this.seq >= 0) this.resync(); // 还没收到快照时只缓存，等快照
  }

  #applyDelta(d) {
    for (const c of d.cells) this.cells.set(BoardSync.key(c.x, c.y), c);
    this.seq = d.seq;
    this.onUpdate('delta', d);
  }

  /** 应用缓存中能接上的 delta；还有断档就安排一次重同步。 */
  #drain() {
    for (const s of [...this.pending.keys()]) if (s <= this.seq) this.pending.delete(s);
    let next;
    while ((next = this.pending.get(this.seq + 1))) {
      this.pending.delete(next.seq);
      this.#applyDelta(next);
    }
    if (this.pending.size === 0) {
      this.retryMs = 500;
    } else if (!this.syncing && !this.retryTimer) {
      // 仍有断档（例如 HTTP 结果比缓存的 delta 还旧）：退避后再拉
      this.retryTimer = true;
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
      this.schedule(() => {
        this.retryTimer = false;
        if (this.pending.size) this.resync();
      }, wait);
    }
  }

  /** 发起 HTTP 全量重同步；同一时间最多一个。 */
  resync() {
    if (this.syncing) return this.syncing;
    const epoch = this.epoch;
    this.syncing = (async () => {
      try {
        const b = await this.fetchBoard();
        if (epoch !== this.epoch) return; // 期间已收到更新的 WS 快照
        if (b.seq < this.seq) return; // 旧响应，不能让 seq 倒退
        this.#applyFull(b);
      } catch {
        // 网络错误：留给 #drain 的退避重试
      } finally {
        this.syncing = null;
        this.#drain();
      }
    })();
    return this.syncing;
  }
}
