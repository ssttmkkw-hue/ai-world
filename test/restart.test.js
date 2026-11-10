// 文件数据库：重启后棋盘、seq、额度、幂等、暂停、主题、快照都能恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './helpers.js';
import { loadSecrets, checkSecrets } from '../src/secrets.js';
import { loadConfig } from '../src/config.js';

const paint = (x, color = 1) => ({ intent: `paint ${x}`, ops: [{ op: 'paint', x, y: 0, color }] });

test('重启恢复：棋盘、seq、额度、幂等、暂停、主题、快照计数', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'world.db');
  const clock = { t: Date.UTC(2026, 10, 10, 12, 0, 0) };
  const env = { RATE_ACTS_PER_MINUTE: '3', SNAPSHOT_EVERY_ACTS: '4' };

  // 第一次运行
  let s = setup(env, { dbPath, clock });
  await s.act(paint(0), { key: 'k0' });
  await s.act(paint(1), { key: 'k1' });
  await s.act({ intent: 'msg', ops: [{ op: 'write', x: 2, y: 0, text: '你好' }] }, { key: 'k2' });
  await s.admin('/v1/admin/theme', { theme: '森林' });
  const snap = (await s.admin('/v1/admin/snapshot')).json();
  assert.equal(snap.seq, 3);
  await s.admin('/v1/admin/pause', { paused: true, reason: '重启测试' });
  await s.app.close();
  s.store.close();

  // 第二次运行（同一个文件）
  s = setup(env, { dbPath, clock });
  t.after(() => { s.app.close(); s.store.close(); });
  const { world } = s;
  assert.equal(world.seq, 3);
  assert.equal(world.cell(1, 0).c, 1);
  assert.equal(world.cell(2, 0).t, '你好');
  assert.equal(world.status().paused, true);
  assert.equal(world.status().pause_reason, '重启测试');
  assert.equal(world.status().theme, '森林');
  assert.equal(world.recent()[0].intent, 'msg');
  assert.equal(world.listSnapshots()[0].id, snap.id);

  // 幂等：重启前的 key 仍能回放（暂停时回放也可用，因为不会再执行）
  const replay = await s.act(paint(1), { key: 'k1' });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().seq, 2);
  assert.equal(replay.json().replayed, true);

  await s.admin('/v1/admin/pause', { paused: false });
  // 额度：重启前已用 3 次，本分钟仍被限
  const limited = await s.act(paint(5));
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error, 'rate_limited');

  // 自动快照计数按 seq 推算：上次快照在 seq 3，再 4 次 act 后（seq 7）自动快照
  clock.t += 61_000;
  for (let i = 0; i < 3; i++) await s.act(paint(10 + i));
  assert.equal(world.listSnapshots().length, 1);
  clock.t += 61_000;
  await s.act(paint(20));
  assert.equal(world.seq, 7);
  assert.equal(world.listSnapshots()[0].seq, 7);
  assert.equal(world.listSnapshots()[0].reason, 'auto');

  // 回滚到重启前的快照
  const rb = (await s.admin('/v1/admin/rollback', { snapshot_id: snap.id })).json();
  assert.equal(rb.seq, 8);
  assert.equal(world.cell(20, 0).v, 8);
  assert.equal(world.cell(20, 0).c, null);
  assert.equal(world.cell(2, 0).t, '你好');
});

test('凭据：首次生成文件并复用；环境变量覆盖；非法配置被拒绝', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = (env = {}) => loadConfig({ DATA_DIR: dir, ...env });

  const first = loadSecrets(cfg());
  assert.ok(first.generatedPath);
  assert.equal((statSync(first.file).mode & 0o777), 0o600);
  assert.deepEqual(first.agents.map((a) => a.id), ['claude-1', 'codex-1', 'cursor-1', 'bot-1']);
  const again = loadSecrets(cfg());
  assert.equal(again.generatedPath, null);
  assert.equal(again.admin, first.admin);
  assert.deepEqual(again.warnings, []);
  assert.ok(JSON.parse(readFileSync(first.file, 'utf8')).admin);

  // 部署用的环境变量（Render）：两者都给时不读写文件
  const envOnly = loadSecrets(loadConfig({
    DATA_DIR: join(dir, 'none'),
    ADMIN_TOKEN: 'admin-token-0123456789abcdef',
    AGENT_TOKENS: 'claude-1:Claude:claude-token-0123456789,codex-1:Codex:codex-token-0123456789',
  }));
  assert.equal(envOnly.admin, 'admin-token-0123456789abcdef');
  assert.deepEqual(envOnly.agents.map((a) => a.name), ['Claude', 'Codex']);

  // 管理员 token 太短 / 与 agent 共用：禁用管理接口但不崩
  const weak = loadSecrets(cfg({ ADMIN_TOKEN: 'short' }));
  assert.equal(weak.admin, null);
  assert.match(weak.warnings[0], /管理接口已禁用/);
  const shared = loadSecrets(cfg({ ADMIN_TOKEN: first.agents[0].token }));
  assert.equal(shared.admin, null);

  // agent 配置错误直接报错
  assert.throws(() => loadSecrets(cfg({ AGENT_TOKENS: 'a:A:tok-0123456789abcdef,b:B:tok-0123456789abcdef' })), /共用同一个 token/);
  assert.throws(() => loadSecrets(cfg({ AGENT_TOKENS: 'a:A:tok-0123456789abcdef,a:B:tok-fedcba9876543210' })), /id 重复/);
  assert.throws(() => loadSecrets(cfg({ AGENT_TOKENS: 'a:A:short' })), /格式错误/);
  assert.throws(() => checkSecrets({ admin: 'x'.repeat(20), agents: [{ id: 'admin', name: 'A', token: 'y'.repeat(20) }] }), /id 不合法/);
  assert.throws(() => checkSecrets({ admin: 'x'.repeat(20), agents: [{ id: 'a', name: 'A', token: 123 }] }), /token/);
  assert.throws(() => checkSecrets({ admin: 'x'.repeat(20), agents: {} }), /非空数组/);
});

test('管理接口禁用时 admin 请求一律 401', async (t) => {
  const { Auth } = await import('../src/secrets.js');
  const auth = new Auth({ admin: null, agents: [] });
  assert.equal(auth.isAdmin({ headers: { authorization: 'Bearer anything' } }), false);
  assert.equal(auth.isAdmin({ headers: {} }), false);
});
