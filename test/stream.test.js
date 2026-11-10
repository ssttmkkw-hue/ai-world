import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setup } from './helpers.js';

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    ws.once('error', reject);
  });
}

test('WS /v1/stream：先全量快照，再收增量；状态变化也推送', async (t) => {
  const { app, act, admin } = setup();
  t.after(() => app.close());
  await act({ intent: 'before', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`);
  const snap = await nextMessage(ws);
  assert.equal(snap.type, 'snapshot');
  assert.equal(snap.seq, 1);
  assert.equal(snap.cells.length, 1);
  assert.equal(snap.recent[0].intent, 'before');

  ws.send('viewers cannot write'); // 被忽略
  const deltaP = nextMessage(ws);
  await act({ intent: '画星星', ops: [{ op: 'place', x: 10, y: 20, object: 'star' }] });
  const delta = await deltaP;
  assert.deepEqual(
    { type: delta.type, seq: delta.seq, by: delta.by, name: delta.name, intent: delta.intent },
    { type: 'delta', seq: 2, by: 'agent-a', name: 'Agent A', intent: '画星星' },
  );
  assert.deepEqual(delta.cells, [{ x: 10, y: 20, c: null, o: 'star', t: null, by: 'agent-a', v: 2 }]);

  const statusP = nextMessage(ws);
  await admin('/v1/admin/theme', { theme: '海边小镇' });
  const status = await statusP;
  assert.equal(status.type, 'status');
  assert.equal(status.theme, '海边小镇');
  ws.close();
});

test('WS：其他路径的 upgrade 被拒绝', async (t) => {
  const { app } = setup();
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/nope`);
  await new Promise((resolve) => ws.on('error', resolve));
});
