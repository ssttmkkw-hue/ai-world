import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, TOKENS } from './helpers.js';

test('act: paint/place/write/clear 落到三层，返回新 seq 和旧值', async (t) => {
  const { app, act } = setup();
  t.after(() => app.close());

  let r = await act({ intent: '画一棵树', ops: [
    { op: 'paint', x: 1, y: 2, color: 8 },
    { op: 'place', x: 1, y: 2, object: 'tree' },
    { op: 'write', x: 1, y: 2, text: '你好' },
  ] });
  assert.equal(r.statusCode, 200, r.body);
  let b = r.json();
  assert.equal(b.seq, 1);
  assert.equal(b.results.length, 3);
  assert.deepEqual(b.results[0].old, { c: null, o: null, t: null, by: null, v: 0 });
  assert.deepEqual(b.results[2].new, { c: 8, o: 'tree', t: '你好', by: 'agent-a', v: 1 });

  r = await act({ intent: '换色', ops: [{ op: 'paint', x: 1, y: 2, color: 'red' }] }, { token: TOKENS.b });
  b = r.json();
  assert.equal(b.seq, 2);
  assert.equal(b.results[0].old.c, 8, '返回被覆盖的旧颜色');
  assert.equal(b.results[0].old.by, 'agent-a');
  assert.equal(b.results[0].new.c, 4);
  assert.equal(b.results[0].new.o, 'tree', '其他层不受影响');

  r = await act({ intent: '清掉物件', ops: [{ op: 'clear', x: 1, y: 2, layer: 'object' }] });
  assert.deepEqual(r.json().results[0].new, { c: 4, o: null, t: '你好', by: 'agent-a', v: 3 });

  const board = (await app.inject('/v1/board')).json();
  assert.equal(board.seq, 3);
  assert.deepEqual(board.cells, [{ x: 1, y: 2, c: 4, o: null, t: '你好', by: 'agent-a', v: 3 }]);
  assert.equal(board.recent[0].intent, '清掉物件');
  assert.equal(board.recent[0].name, 'Agent A');

  const text = (await app.inject('/v1/board?format=text')).body;
  assert.match(text, /seq=3/);
  assert.match(text, /UNTRUSTED/);
  assert.match(text, /\(1,2\) v=3 by=agent-a text="你好"/);
  const row2 = text.split('\n').filter((l) => l.startsWith('02 '))[0];
  assert.equal(row2.slice(3, 6), '.4.');
});

test('act: 需要 agent token', async (t) => {
  const { app, act } = setup();
  t.after(() => app.close());
  const r = await act({ intent: 'x', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] }, { token: 'nope' });
  assert.equal(r.statusCode, 401);
  const r2 = await act({ intent: 'x', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] }, { token: TOKENS.admin });
  assert.equal(r2.statusCode, 401, 'admin token 不能当 agent 用');
});

test('if_v：版本不一致时整个 act 不写入，返回 409', async (t) => {
  const { app, act, world } = setup();
  t.after(() => app.close());
  await act({ intent: 'a', ops: [{ op: 'paint', x: 5, y: 5, color: 1 }] });
  assert.equal(world.cell(5, 5).v, 1);
  const r = await act({ intent: 'b', ops: [
    { op: 'paint', x: 6, y: 6, color: 2 },
    { op: 'paint', x: 5, y: 5, color: 3, if_v: 0 },
  ] });
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().conflicts, [{ i: 1, x: 5, y: 5, if_v: 0, v: 1 }]);
  assert.equal(world.seq, 1);
  assert.equal(world.cell(6, 6).v, 0, '原子：同一 act 的其他 op 也没写');
  const ok = await act({ intent: 'c', ops: [{ op: 'paint', x: 5, y: 5, color: 3, if_v: 1 }] });
  assert.equal(ok.statusCode, 200);
});

test('暂停后拒绝写入；快照回滚作为新 seq 写入', async (t) => {
  const { app, act, admin, world } = setup();
  t.after(() => app.close());
  await act({ intent: 'a', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] });
  const snap = (await admin('/v1/admin/snapshot')).json();
  assert.equal(snap.seq, 1);
  await act({ intent: 'b', ops: [{ op: 'paint', x: 0, y: 0, color: 2 }, { op: 'place', x: 3, y: 3, object: 'star' }] });

  assert.equal((await admin('/v1/admin/pause', { paused: true, reason: '维护' })).json().paused, true);
  const r = await act({ intent: 'c', ops: [{ op: 'paint', x: 0, y: 0, color: 3 }] });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'paused');

  const rb = (await admin('/v1/admin/rollback', { snapshot_id: snap.id })).json();
  assert.equal(rb.seq, 3);
  assert.equal(rb.changed, 2);
  assert.equal(world.cell(0, 0).c, 1);
  assert.equal(world.cell(3, 3).o, null);
  assert.equal(world.cell(0, 0).by, 'admin');

  await admin('/v1/admin/pause', { paused: false });
  assert.equal((await act({ intent: 'd', ops: [{ op: 'paint', x: 0, y: 0, color: 3 }] })).statusCode, 200);

  const noauth = await app.inject({ method: 'POST', url: '/v1/admin/pause', headers: { authorization: `Bearer ${TOKENS.a}` }, payload: {} });
  assert.equal(noauth.statusCode, 401);
});
