import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, TOKENS } from './helpers.js';

const paint = (x = 0, color = 1) => ({ intent: 'p', ops: [{ op: 'paint', x, y: 0, color }] });

test('幂等：同 key 同 body 回放同一结果，不产生新 seq', async (t) => {
  const { app, act, world } = setup();
  t.after(() => app.close());
  const r1 = await act(paint(), { key: 'same' });
  const r2 = await act(paint(), { key: 'same' });
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().seq, r1.json().seq);
  assert.equal(r2.json().replayed, true);
  assert.equal(world.seq, 1);
});

test('幂等：同 key 不同 body → 422；不同 agent 的同 key 互不影响', async (t) => {
  const { app, act, world } = setup();
  t.after(() => app.close());
  await act(paint(0, 1), { key: 'k' });
  const r = await act(paint(0, 2), { key: 'k' });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().error, 'idempotency_key_reused');
  const rb = await act(paint(0, 2), { key: 'k', token: TOKENS.b });
  assert.equal(rb.statusCode, 200);
  assert.equal(world.seq, 2);
});

test('幂等：缺少 Idempotency-Key → 400', async (t) => {
  const { app, act } = setup();
  t.after(() => app.close());
  const r = await act(paint(), { key: null });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'idempotency_key_required');
});

test('限频：每分钟 act 次数', async (t) => {
  const { app, act, clock } = setup({ RATE_ACTS_PER_MINUTE: '3' });
  t.after(() => app.close());
  for (let i = 0; i < 3; i++) assert.equal((await act(paint(i))).statusCode, 200);
  const r = await act(paint(9));
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error, 'rate_limited');
  assert.ok(Number(r.headers['retry-after']) >= 1);
  assert.equal((await act(paint(9), { token: TOKENS.b })).statusCode, 200, '按 agent 分开计');
  clock.t += 61_000;
  assert.equal((await act(paint(9))).statusCode, 200, '窗口过去后恢复');
});

test('限频：每小时 op 预算', async (t) => {
  const { app, act, clock } = setup({ RATE_OPS_PER_HOUR: '40' });
  t.after(() => app.close());
  const ops = (n) => ({ intent: 'bulk', ops: Array.from({ length: n }, (_, i) => ({ op: 'paint', x: i, y: 1, color: 2 })) });
  assert.equal((await act(ops(32))).statusCode, 200);
  const r = await act(ops(9));
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error, 'op_budget_exceeded');
  assert.equal((await act(ops(8))).statusCode, 200, '正好用满预算');
  clock.t += 3_601_000;
  assert.equal((await act(ops(32))).statusCode, 200);
});
