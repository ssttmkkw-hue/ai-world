// 内存固定窗口限流：用于匿名读取、WS 握手和 /v1/act 请求次数（含非法请求和幂等回放）。
// 这一层只防刷接口；每个 agent 的 act 次数和 op 预算仍由 world.js 按数据库计算。

export class WindowLimiter {
  constructor({ limit, windowMs = 60_000, now = Date.now, maxKeys = 50_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    this.map = new Map(); // key -> { start, count }
  }

  /** 记一次。返回 { ok, retryAfter }。limit<=0 表示不限。 */
  hit(key) {
    if (!(this.limit > 0)) return { ok: true, retryAfter: 0 };
    const now = this.now();
    let e = this.map.get(key);
    if (!e || now - e.start >= this.windowMs) {
      if (!e && this.map.size >= this.maxKeys) this.#sweep(now);
      e = { start: now, count: 0 };
      this.map.set(key, e);
    }
    e.count++;
    if (e.count > this.limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((e.start + this.windowMs - now) / 1000)) };
    }
    return { ok: true, retryAfter: 0 };
  }

  #sweep(now) {
    for (const [k, e] of this.map) if (now - e.start >= this.windowMs) this.map.delete(k);
    // 仍然太多（被大量不同 key 冲击）：整体清空，宁可放过也不让内存无限增长
    if (this.map.size >= this.maxKeys) this.map.clear();
  }
}

/**
 * 取客户端 IP。trustHops=0 时用 socket 地址；trustHops=n 时信任最右边 n 个代理，
 * 取 X-Forwarded-For 从右数第 n 个（与 proxy-addr 的「信任 n 跳」一致），不信任客户端自填的左侧部分。
 */
export function clientIp(rawReq, trustHops = 0) {
  const sock = rawReq.socket?.remoteAddress || 'unknown';
  if (!(trustHops > 0)) return sock;
  const xff = String(rawReq.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!xff.length) return sock;
  return xff[Math.max(0, xff.length - trustHops)];
}

/** WS 背压：发送队列超过上限的慢客户端直接断开（它重连后会重新拿全量快照）。 */
export function sendOrDrop(ws, data, maxBuffered) {
  if (ws.readyState !== 1) return 'skip';
  if (ws.bufferedAmount > maxBuffered) {
    ws.terminate();
    return 'dropped';
  }
  ws.send(data);
  return 'sent';
}
