// 资源与安全边界：WS 背压、请求限流、请求体上限、读缓存。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setup, TOKENS } from './helpers.js';
import { WindowLimiter, clientIp, sendOrDrop } from '../src/ratelimit.js';

test('sendOrDrop：发送队列超限就断开，正常时发送', () => {
  const mk = (buffered) => ({ readyState: 1, bufferedAmount: buffered, sent: [], terminated: false,
    send(d) { this.sent.push(d); }, terminate() { this.terminated = true; } });
  const ok = mk(10);
  assert.equal(sendOrDrop(ok, 'x', 100), 'sent');
  const slow = mk(101);
  assert.equal(sendOrDrop(slow, 'x', 100), 'dropped');
  assert.equal(slow.terminated, true);
  assert.equal(slow.sent.length, 0);
  assert.equal(sendOrDrop({ readyState: 3 }, 'x', 100), 'skip');
});

test('慢 WS 客户端在广播时被断开', async (t) => {
  const { app, act } = setup({}, { appOpts: { maxBuffered: -1 } }); // 任何积压都算超限
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/stream`);
  await new Promise((r) => ws.once('message', r));
  const closed = new Promise((r) => ws.once('close', r));
  await act({ intent: 'x', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] });
  await closed;
});

test('WindowLimiter 与 clientIp', () => {
  const clock = { t: 0 };
  const l = new WindowLimiter({ limit: 2, now: () => clock.t });
  assert.equal(l.hit('a').ok, true);
  assert.equal(l.hit('a').ok, true);
  const r = l.hit('a');
  assert.equal(r.ok, false);
  assert.equal(r.retryAfter, 60);
  assert.equal(l.hit('b').ok, true);
  clock.t = 60_000;
  assert.equal(l.hit('a').ok, true);
  assert.equal(new WindowLimiter({ limit: 0 }).hit('x').ok, true, '0 = 不限');

  const req = { socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' } };
  assert.equal(clientIp(req, 0), '10.0.0.1', '默认不信任 XFF');
  assert.equal(clientIp(req, 1), '1.2.3.4', '信任 1 跳：取最右（代理写入的）');
  assert.equal(clientIp(req, 2), '6.6.6.6');
  assert.equal(clientIp(req, 9), '6.6.6.6');
});

test('匿名读取按 IP 限流', async (t) => {
  const { app } = setup({ API_REQUESTS_PER_MINUTE_PER_IP: '3' });
  t.after(() => app.close());
  for (let i = 0; i < 3; i++) assert.equal((await app.inject('/v1/board')).statusCode, 200);
  const r = await app.inject('/v1/board');
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers['retry-after']) >= 1);
  assert.equal((await app.inject('/')).statusCode, 200, '静态页不计入');
});

test('/v1/act 请求次数限流：非法请求和回放也计数', async (t) => {
  const { app, act } = setup({ ACT_REQUESTS_PER_MINUTE: '3' });
  t.after(() => app.close());
  for (let i = 0; i < 3; i++) assert.equal((await act({ intent: 'bad', ops: [] })).statusCode, 400);
  const r = await act({ intent: 'ok', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] });
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error, 'too_many_requests');
  assert.equal((await act({ intent: 'ok', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] }, { token: TOKENS.b })).statusCode, 200, '按 agent 分开');
});

test('WS 握手按 IP 限流', async (t) => {
  const { app } = setup({ WS_CONNECTS_PER_MINUTE_PER_IP: '1' });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${app.server.address().port}/v1/stream`;
  const ok = new WebSocket(url);
  await new Promise((r) => ok.once('message', r));
  const second = new WebSocket(url);
  const status = await new Promise((r) => second.once('unexpected-response', (req, res) => r(res.statusCode)));
  assert.equal(status, 429);
  ok.close();
});

test('请求体超过 64KB → 413', async (t) => {
  const { app } = setup();
  t.after(() => app.close());
  const r = await app.inject({
    method: 'POST', url: '/v1/act',
    headers: { authorization: `Bearer ${TOKENS.a}`, 'idempotency-key': 'big', 'content-type': 'application/json' },
    payload: JSON.stringify({ intent: 'x'.repeat(70_000), ops: [] }),
  });
  assert.equal(r.statusCode, 413);
});

test('读缓存：写入、暂停、主题变化后立即失效', async (t) => {
  const { app, act, admin } = setup();
  t.after(() => app.close());
  const board = async (q = '') => (await app.inject(`/v1/board${q}`)).json();
  assert.equal((await board()).seq, 0);
  await act({ intent: 'x', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] });
  assert.equal((await board()).seq, 1);
  assert.equal((await board()).cells.length, 1);
  await admin('/v1/admin/theme', { theme: '新主题' });
  assert.equal((await board()).theme, '新主题');
  assert.match((await app.inject('/v1/board?format=text')).body, /新主题/);
  assert.equal((await board('?recent=1')).recent.length, 1);
});
