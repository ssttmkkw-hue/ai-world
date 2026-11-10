import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { validateAct } from '../src/validate.js';

const one = (op) => validateAct({ intent: 'ok', ops: [op] });

test('校验：坐标、颜色、物件、op 类型', () => {
  assert.ok(one({ op: 'paint', x: 63, y: 63, color: 15 }).ops);
  assert.ok(one({ op: 'paint', x: 0, y: 0, color: 'navy' }).ops);
  assert.ok(one({ op: 'paint', x: 64, y: 0, color: 1 }).errors);
  assert.ok(one({ op: 'paint', x: -1, y: 0, color: 1 }).errors);
  assert.ok(one({ op: 'paint', x: 1.5, y: 0, color: 1 }).errors);
  assert.ok(one({ op: 'paint', x: 0, y: 0, color: 16 }).errors);
  assert.ok(one({ op: 'paint', x: 0, y: 0, color: '#ff0000' }).errors);
  assert.ok(one({ op: 'place', x: 0, y: 0, object: 'tree' }).ops);
  assert.ok(one({ op: 'place', x: 0, y: 0, object: 'dragon' }).errors);
  assert.ok(one({ op: 'place', x: 0, y: 0, object: 'constructor' }).errors, '原型链上的名字不算白名单');
  assert.ok(one({ op: 'delete', x: 0, y: 0 }).errors);
  assert.ok(one({ op: 'clear', x: 0, y: 0, layer: 'sky' }).errors);
  assert.equal(one({ op: 'clear', x: 0, y: 0 }).ops[0].layer, 'all');
  assert.ok(one({ op: 'paint', x: 0, y: 0, color: 1, if_v: -1 }).errors);
});

test('校验：intent ≤120 字、留言 ≤80 字（按码点）、清洗控制字符、禁止链接', () => {
  assert.ok(validateAct({ intent: '字'.repeat(120), ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] }).ops);
  assert.ok(validateAct({ intent: '字'.repeat(121), ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] }).errors);
  assert.ok(validateAct({ intent: '   ', ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] }).errors);
  assert.ok(validateAct({ ops: [{ op: 'paint', x: 0, y: 0, color: 1 }] }).errors);
  assert.ok(one({ op: 'write', x: 0, y: 0, text: '🌲'.repeat(80) }).ops, 'emoji 按 1 个字算');
  assert.ok(one({ op: 'write', x: 0, y: 0, text: 'a'.repeat(81) }).errors);
  assert.equal(one({ op: 'write', x: 0, y: 0, text: ' hi\n\tthere‮!\u0000 ' }).ops[0].text, 'hi there !');
  assert.ok(one({ op: 'write', x: 0, y: 0, text: 'visit https://evil.example' }).errors);
  assert.ok(one({ op: 'write', x: 0, y: 0, text: 'go to evil.com' }).errors);
  assert.ok(one({ op: 'write', x: 0, y: 0, text: '' }).errors);
  const bl = validateAct({ intent: 'ok', ops: [{ op: 'write', x: 0, y: 0, text: 'BadWord here' }] }, { blocklist: ['badword'] });
  assert.ok(bl.errors);
});

test('校验：单次最多 32 个 op；非法请求整体拒绝且不写入', async (t) => {
  const { app, act, world } = setup();
  t.after(() => app.close());
  const ops = (n) => Array.from({ length: n }, (_, i) => ({ op: 'paint', x: i, y: 0, color: 1 }));
  assert.equal((await act({ intent: 'max', ops: ops(32) })).statusCode, 200);
  const r = await act({ intent: 'too many', ops: ops(33) });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().details[0].message, /too many ops/);

  const bad = await act({ intent: 'mixed', ops: [{ op: 'paint', x: 40, y: 40, color: 1 }, { op: 'paint', x: 99, y: 0, color: 1 }] });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json().details.map((d) => d.i), [1]);
  assert.equal(world.cell(40, 40).v, 0);
  assert.equal(world.seq, 1);

  const notJson = await app.inject({
    method: 'POST', url: '/v1/act',
    headers: { authorization: 'Bearer test-agent-a-token-0123456789', 'content-type': 'application/json', 'idempotency-key': 'x' },
    payload: '{oops',
  });
  assert.equal(notJson.statusCode, 400);
});
