// HTTP + WebSocket 组装。buildApp() 不监听端口，便于测试。
import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  WIDTH, HEIGHT, PALETTE, OBJECTS, MAX_OPS_PER_ACT, MAX_INTENT_LEN, MAX_TEXT_LEN, UNTRUSTED_NOTICE,
} from './config.js';
import { HttpError } from './world.js';
import { renderText } from './textmap.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_VIEWERS = 500;

export function buildApp({ world, auth, logger = false }) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });

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
    app.get(route, (req, reply) => {
      // 开发期每次读盘，改前端不用重启
      const body = readFileSync(join(PUBLIC, file));
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
    const recent = Number.parseInt(req.query.recent ?? '20', 10) || 20;
    if (format === 'text' || format === 'ascii') {
      reply.type('text/plain; charset=utf-8').send(renderText(world, { recent }));
      return;
    }
    if (format !== 'json') throw new HttpError(400, { error: 'invalid', message: 'format must be json|text|ascii' });
    reply.send({
      ...world.status(),
      width: WIDTH,
      height: HEIGHT,
      notice: UNTRUSTED_NOTICE,
      limits: { max_ops_per_act: MAX_OPS_PER_ACT, max_intent_len: MAX_INTENT_LEN, max_text_len: MAX_TEXT_LEN },
      palette: PALETTE.map((p, i) => ({ i, ...p })),
      objects: Object.keys(OBJECTS),
      cells: world.sparseCells(),
      recent: world.recent(recent),
    });
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
    if (path !== '/v1/stream' || wss.clients.size >= MAX_VIEWERS) {
      socket.write('HTTP/1.1 ' + (path === '/v1/stream' ? '503 Service Unavailable' : '404 Not Found') + '\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', () => {}); // 只读：忽略客户端消息
      ws.on('error', () => {});
      ws.send(JSON.stringify(world.snapshotMessage()));
    });
  });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
  };
  world.on('delta', broadcast);
  world.on('status', broadcast);

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
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });

  return app;
}
