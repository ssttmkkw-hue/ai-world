// HTTP + WebSocket 组装。buildApp() 不监听端口，便于测试。
import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  WIDTH, HEIGHT, PALETTE, OBJECTS, MAX_OPS_PER_ACT, MAX_INTENT_LEN, MAX_TEXT_LEN, UNTRUSTED_NOTICE,
  MAX_VIEWERS, WS_MAX_BUFFERED, RECENT_DEFAULT, RECENT_MAX,
} from './config.js';
import { HttpError } from './world.js';
import { renderText } from './textmap.js';
import { WindowLimiter, clientIp, sendOrDrop } from './ratelimit.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/sync.js': ['sync.js', 'text/javascript; charset=utf-8'],
};

export function buildApp({ world, auth, logger = false, now = Date.now, maxBuffered = WS_MAX_BUFFERED }) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
  const cfg = world.config;
  const ipOf = (raw) => clientIp(raw, cfg.trustProxy);
  const apiLimiter = new WindowLimiter({ limit: cfg.apiRequestsPerMinutePerIp, now });
  const wsLimiter = new WindowLimiter({ limit: cfg.wsConnectsPerMinutePerIp, now });
  const actLimiter = new WindowLimiter({ limit: cfg.actRequestsPerMinute, now });
  const tooMany = (retryAfter, message) =>
    new HttpError(429, { error: 'too_many_requests', message, retry_after: retryAfter }, { 'retry-after': String(retryAfter) });

  // 匿名限流：所有 /v1/* 请求按 IP 计数（包括无效 token、非法请求）
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/v1/')) return;
    const r = apiLimiter.hit(ipOf(req.raw));
    if (!r.ok) throw tooMany(r.retryAfter, 'too many requests from this address');
  });

  // 读接口缓存：同一 world.version 下直接复用序列化结果，避免反复遍历棋盘、解析日志
  let cacheVersion = -1;
  const cache = new Map();
  const cached = (key, build) => {
    if (cacheVersion !== world.version) {
      cache.clear();
      cacheVersion = world.version;
    }
    let v = cache.get(key);
    if (v === undefined) {
      v = build();
      cache.set(key, v);
    }
    return v;
  };

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      reply.headers(err.headers).code(err.status).send(err.body);
      return;
    }
    if (err.statusCode && err.statusCode < 500) {
      reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'internal' });
  });

  // ---------- 观众页 ----------
  for (const [route, [file, type]] of Object.entries(STATIC)) {
    const body = readFileSync(join(PUBLIC, file)); // 启动时读入内存；改前端需重启
    app.get(route, (req, reply) => {
      reply.type(type);
      if (file === 'index.html') {
        reply.header(
          'content-security-policy',
          "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
      }
      reply.send(body);
    });
  }

  // ---------- 读 ----------
  app.get('/v1/board', (req, reply) => {
    const format = String(req.query.format || 'json');
    const n = Number.parseInt(req.query.recent ?? '', 10);
    const recent = Math.min(Math.max(1, Number.isFinite(n) ? n : RECENT_DEFAULT), RECENT_MAX);
    if (format === 'text' || format === 'ascii') {
      reply.type('text/plain; charset=utf-8').send(cached(`text:${recent}`, () => renderText(world, { recent })));
      return;
    }
    if (format !== 'json') throw new HttpError(400, { error: 'invalid', message: 'format must be json|text|ascii' });
    reply.type('application/json; charset=utf-8').send(cached(`json:${recent}`, () => JSON.stringify({
      ...world.status(),
      width: WIDTH,
      height: HEIGHT,
      notice: UNTRUSTED_NOTICE,
      limits: { max_ops_per_act: MAX_OPS_PER_ACT, max_intent_len: MAX_INTENT_LEN, max_text_len: MAX_TEXT_LEN },
      palette: PALETTE.map((p, i) => ({ i, ...p })),
      objects: Object.keys(OBJECTS),
      cells: world.sparseCells(),
      recent: world.recent(recent),
    })));
  });

  app.get('/v1/meta', () => ({
    width: WIDTH,
    height: HEIGHT,
    palette: PALETTE.map((p, i) => ({ i, ...p })),
    objects: Object.fromEntries(Object.entries(OBJECTS).map(([k, v]) => [k, v.glyph])),
  }));

  app.get('/v1/me', (req) => {
    const agent = requireAgent(req);
    return { id: agent.id, name: agent.name, usage: world.usage(agent.id) };
  });

  // ---------- 写 ----------
  function requireAgent(req) {
    const agent = auth.agent(req);
    if (!agent) throw new HttpError(401, { error: 'unauthorized', message: 'Authorization: Bearer <agent token> required' });
    return agent;
  }
  function requireAdmin(req) {
    if (!auth.isAdmin(req)) throw new HttpError(401, { error: 'unauthorized', message: 'admin token required' });
  }

  app.post('/v1/act', (req, reply) => {
    const agent = requireAgent(req);
    const r = actLimiter.hit(agent.id);
    if (!r.ok) throw tooMany(r.retryAfter, `max ${cfg.actRequestsPerMinute} act requests per minute (including rejected ones)`);
    const { status, body } = world.act(agent, req.headers['idempotency-key'], req.body);
    reply.code(status).send(body);
  });

  // ---------- 管理 ----------
  app.post('/v1/admin/pause', (req) => {
    requireAdmin(req);
    const b = req.body || {};
    return world.setPaused(b.paused !== false, b.reason);
  });
  app.post('/v1/admin/theme', (req) => {
    requireAdmin(req);
    return world.setTheme((req.body || {}).theme);
  });
  app.post('/v1/admin/snapshot', (req) => {
    requireAdmin(req);
    return world.snapshot('manual');
  });
  app.get('/v1/admin/snapshots', (req) => {
    requireAdmin(req);
    return { snapshots: world.listSnapshots(req.query.limit) };
  });
  app.post('/v1/admin/rollback', (req) => {
    requireAdmin(req);
    const id = (req.body || {}).snapshot_id;
    if (!Number.isInteger(id)) throw new HttpError(400, { error: 'invalid', message: 'snapshot_id (integer) required' });
    return world.rollback(id);
  });

  // ---------- WS /v1/stream（只读） ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  app.server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    const reject = (status) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (path !== '/v1/stream') return reject('404 Not Found');
    if (!wsLimiter.hit(ipOf(req)).ok) return reject('429 Too Many Requests');
    if (wss.clients.size >= MAX_VIEWERS) return reject('503 Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', () => {}); // 只读：忽略客户端消息
      ws.on('error', () => {});
      ws.send(cached('ws-snapshot', () => JSON.stringify(world.snapshotMessage())));
    });
  });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) sendOrDrop(ws, data, maxBuffered);
  };
  world.on('delta', broadcast);
  world.on('status', broadcast);
  const warn = (m) => app.log.warn(m);
  world.on('warn', warn);

  // 心跳：清理死连接
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  hb.unref();

  app.addHook('onClose', async () => {
    clearInterval(hb);
    world.off('delta', broadcast);
    world.off('status', broadcast);
    world.off('warn', warn);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });

  return app;
}
