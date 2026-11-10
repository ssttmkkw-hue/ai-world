// 观众端同步状态机（public/sync.js）：断档、并发重同步、旧 HTTP 响应、WS 快照抢先、status 不推进 seq。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardSync } from '../public/sync.js';

const cell = (x, c, v) => ({ x, y: 0, c, o: null, t: null, by: 'a', v });
const snapshot = (seq, cells = []) => ({ type: 'snapshot', seq, paused: false, theme: '', cells, recent: [] });
const delta = (seq, x = seq) => ({ type: 'delta', seq, by: 'a', intent: 'i', cells: [cell(x, 1, seq)] });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  const fetches = [];
  const timers = [];
  const sync = new BoardSync({
    fetchBoard: () => { const d = deferred(); fetches.push(d); return d.promise; },
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  return { sync, fetches, timers };
}

test('连续 delta 直接应用；旧 delta 忽略', () => {
  const { sync, fetches } = harness();
  sync.handle(snapshot(2));
  sync.handle(delta(3));
  sync.handle(delta(3));
  sync.handle(delta(2));
  assert.equal(sync.seq, 3);
  assert.equal(fetches.length, 0);
});

test('断档：只发一个重同步，期间的 delta 缓存，之后按序补上', async () => {
  const { sync, fetches } = harness();
  sync.handle(snapshot(2));
  sync.handle(delta(5));
  sync.handle(delta(7));
  sync.handle(delta(6));
  assert.equal(fetches.length, 1, '多次断档只发起一次请求');
  assert.equal(sync.seq, 2);
  fetches[0].resolve(snapshot(4, [cell(3, 2, 3), cell(4, 2, 4)]));
  await sync.syncing;
  assert.equal(sync.seq, 7, 'HTTP 全量(4) + 缓存的 5,6,7');
  assert.equal(sync.cells.size, 5);
  assert.equal(sync.pending.size, 0);
});

test('迟到的旧 HTTP 响应不能让 seq 倒退', async () => {
  const { sync, fetches, timers } = harness();
  sync.handle(snapshot(4));
  sync.handle(delta(6)); // 断档 → 重同步
  fetches[0].resolve(snapshot(2)); // 比本地还旧
  await sync.syncing;
  assert.equal(sync.seq, 4, '没有倒退到 2');
  assert.equal(timers.length, 1, '仍有断档，安排退避重试');
  timers[0].fn();
  assert.equal(fetches.length, 2);
  fetches[1].resolve(snapshot(5));
  await sync.syncing;
  assert.equal(sync.seq, 6);
});

test('重同步进行中收到 WS 快照：采用 WS 快照，丢弃之后到达的 HTTP 结果', async () => {
  const { sync, fetches } = harness();
  sync.handle(snapshot(1));
  sync.handle(delta(3));
  sync.handle(snapshot(9, [cell(9, 3, 9)])); // 重连后的新快照
  sync.handle(delta(10));
  assert.equal(sync.seq, 9, '重同步未结束前 delta 先缓存');
  fetches[0].resolve(snapshot(5));
  await fetches[0].promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(sync.seq, 10, 'HTTP(5) 被作废，缓存的 10 已应用');
  assert.equal(sync.cells.has('9,0'), true);
});

test('重同步失败：退避后重试', async () => {
  const { sync, fetches, timers } = harness();
  sync.handle(snapshot(1));
  sync.handle(delta(3));
  fetches[0].reject(new Error('offline'));
  await sync.syncing;
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 500);
  timers[0].fn();
  fetches[1].resolve(snapshot(3));
  await sync.syncing;
  assert.equal(sync.seq, 3);
});

test('status 只更新暂停/主题，不推进 seq；快照前到达的 delta 先缓存', () => {
  const { sync, fetches } = harness();
  sync.handle(delta(5));
  assert.equal(fetches.length, 0);
  sync.handle(snapshot(4));
  assert.equal(sync.seq, 5, '快照后补上缓存的 5');
  sync.handle({ type: 'status', seq: 99, paused: true, pause_reason: 'x', theme: 't' });
  assert.equal(sync.seq, 5);
  assert.deepEqual(sync.status, { paused: true, pause_reason: 'x', theme: 't' });
});
