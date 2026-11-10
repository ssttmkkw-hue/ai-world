// 提交边界故障注入：棋盘、日志、幂等记录必须同生共死；提交后的步骤失败不能把成功报告成失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const body = (color = 1) => ({ intent: 'p', ops: [{ op: 'paint', x: 0, y: 0, color }, { op: 'paint', x: 1, y: 0, color }] });
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

function inject(store, name, err = new Error(`injected ${name} failure`)) {
  const orig = store.q[name].run;
  store.q[name].run = () => { throw err; };
  return () => { store.q[name].run = orig; };
}

test('幂等记录写入失败：整个 act 回滚（库、内存、广播都没有变化），同 key 重试只执行一次', async (t) => {
  const { app, act, world, store } = setup();
  t.after(() => app.close());
  const deltas = [];
  world.on('delta', (d) => deltas.push(d));

  const restore = inject(store, 'putIdem');
  const r1 = await act(body(), { key: 'retry-me' });
  assert.equal(r1.statusCode, 500);
  assert.equal(world.seq, 0);
  assert.equal(world.cell(0, 0).v, 0, '内存没有被改');
  assert.equal(count(store, 'acts'), 0, '日志没有落库');
  assert.equal(count(store, 'cells'), 0, '格子没有落库');
  assert.equal(deltas.length, 0, '没有广播');
  restore();

  const r2 = await act(body(), { key: 'retry-me' });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().seq, 1);
  const r3 = await act(body(), { key: 'retry-me' });
  assert.equal(r3.json().seq, 1);
  assert.equal(r3.json().replayed, true);
  assert.equal(world.seq, 1);
  assert.equal(count(store, 'acts'), 1);
  assert.equal(deltas.length, 1);
});

test('写格子中途失败：事务回滚，不留半个 act', async (t) => {
  const { app, act, world, store } = setup();
  t.after(() => app.close());
  const orig = store.q.upsertCell.run;
  let n = 0;
  store.q.upsertCell.run = (...a) => { if (++n === 2) throw new Error('disk full'); return orig.apply(store.q.upsertCell, a); };
  assert.equal((await act(body())).statusCode, 500);
  store.q.upsertCell.run = orig;
  assert.equal(count(store, 'cells'), 0);
  assert.equal(count(store, 'idempotency'), 0);
  assert.equal(world.seq, 0);
  assert.equal((await act(body())).json().seq, 1, 'seq 没有被跳号');
});

test('自动快照失败：动作照常成功、可回放，下一次 act 会补做快照', async (t) => {
  const { app, act, world, store } = setup({ SNAPSHOT_EVERY_ACTS: '1' });
  t.after(() => app.close());
  const warns = [];
  world.on('warn', (w) => warns.push(w));

  const restore = inject(store, 'insertSnap');
  const r = await act(body(), { key: 'snap' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().seq, 1);
  assert.match(warns[0], /auto snapshot failed/);
  const replay = await act(body(), { key: 'snap' });
  assert.equal(replay.json().replayed, true);
  assert.equal(world.seq, 1, '重试没有再执行一次');
  restore();

  await act(body(2));
  assert.equal(count(store, 'snapshots'), 1);
  assert.equal(world.listSnapshots()[0].seq, 2);
});

test('广播监听器抛错：不影响已提交的动作', async (t) => {
  const { app, act, world } = setup();
  t.after(() => app.close());
  world.on('delta', () => { throw new Error('viewer exploded'); });
  const r = await act(body());
  assert.equal(r.statusCode, 200);
  assert.equal(world.seq, 1);
});

test('幂等回放与首次响应完全一致（含 usage）', async (t) => {
  const { app, act } = setup();
  t.after(() => app.close());
  const first = (await act(body(), { key: 'same' })).json();
  assert.deepEqual(first.usage, { acts_last_minute: 1, ops_last_hour: 2, acts_per_minute_limit: 100, ops_per_hour_limit: 1000 });
  const again = (await act(body(), { key: 'same' })).json();
  assert.deepEqual(again, { ...first, replayed: true });
});

test('幂等 key 24 小时后过期：之后同 key 视为新请求', async (t) => {
  const { app, act, world, clock, store } = setup();
  t.after(() => app.close());
  await act(body(1), { key: 'old' });
  clock.t += 23 * 3600_000;
  assert.equal((await act(body(1), { key: 'old' })).json().replayed, true, '24 小时内仍回放');
  assert.equal((await act(body(2), { key: 'old' })).statusCode, 422);
  clock.t += 1 * 3600_000 + 1;
  const r = await act(body(2), { key: 'old' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().seq, 2);
  assert.equal(world.seq, 2);
  assert.equal(count(store, 'idempotency'), 1, '过期记录被替换/清理');
});
