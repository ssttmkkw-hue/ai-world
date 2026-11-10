#!/usr/bin/env node
// 不调 LLM 的脚本测试 bot：读棋盘 → 在一个随机位置画个小图案 → 结束（或循环）。
// 用法：
//   npm run bot                       # 用 data/secrets.json 里的 bot-1，跑 1 轮
//   npm run bot -- --rounds 5 --delay 3000
//   AI_WORLD_TOKEN=... AI_WORLD_URL=http://127.0.0.1:8787 npm run bot
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

try { process.loadEnvFile('.env'); } catch { /* optional */ }

const args = process.argv.slice(2);
const arg = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const BASE = process.env.AI_WORLD_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
const ROUNDS = Number(arg('rounds', 1));
const DELAY = Number(arg('delay', 2000));
const AGENT = arg('agent', 'bot-1');

function token() {
  if (process.env.AI_WORLD_TOKEN) return process.env.AI_WORLD_TOKEN;
  const f = `${process.env.DATA_DIR || './data'}/secrets.json`;
  if (!existsSync(f)) throw new Error(`没有 token：先 npm start 生成 ${f}，或设置 AI_WORLD_TOKEN`);
  const a = JSON.parse(readFileSync(f, 'utf8')).agents.find((x) => x.id === AGENT);
  if (!a) throw new Error(`${f} 里没有 agent ${AGENT}`);
  return a.token;
}

const TOKEN = token();
const rnd = (n) => Math.floor(Math.random() * n);

const PATTERNS = [
  { name: '一棵树和草地', build: (x, y) => [
    { op: 'paint', x, y: y + 1, color: 'green' }, { op: 'paint', x: x - 1, y: y + 1, color: 'lime' },
    { op: 'paint', x: x + 1, y: y + 1, color: 'lime' }, { op: 'place', x, y, object: 'tree' },
  ] },
  { name: '小房子', build: (x, y) => [
    { op: 'paint', x, y, color: 'brown' }, { op: 'paint', x: x + 1, y, color: 'brown' },
    { op: 'paint', x, y: y - 1, color: 'red' }, { op: 'paint', x: x + 1, y: y - 1, color: 'red' },
    { op: 'place', x, y, object: 'house' },
  ] },
  { name: '一面旗和留言', build: (x, y) => [
    { op: 'paint', x, y, color: 'yellow' }, { op: 'place', x, y, object: 'flag' },
    { op: 'write', x, y, text: `testbot 到此一游 #${rnd(1000)}` },
  ] },
  { name: '彩虹条', build: (x, y) => [4, 5, 6, 7, 9, 10, 12].map((c, i) => ({ op: 'paint', x: x + i - 3, y, color: c })) },
];

async function round(i) {
  const board = await (await fetch(`${BASE}/v1/board?format=json&recent=3`)).json();
  const p = PATTERNS[rnd(PATTERNS.length)];
  const x = 4 + rnd(board.width - 8);
  const y = 4 + rnd(board.height - 8);
  const ops = p.build(x, y);
  const res = await fetch(`${BASE}/v1/act`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ intent: `[脚本测试] 在 (${x},${y}) 画${p.name}`, ops }),
  });
  const body = await res.json();
  if (res.ok) {
    console.log(`#${i + 1} seq=${body.seq} ${p.name} @(${x},${y}) ops=${ops.length} 本小时已用 ${body.usage.ops_last_hour}/${body.usage.ops_per_hour_limit}`);
  } else {
    console.log(`#${i + 1} HTTP ${res.status}`, body);
    if (res.status === 429 && body.retry_after) return body.retry_after * 1000;
  }
  return 0;
}

for (let i = 0; i < ROUNDS; i++) {
  const wait = await round(i);
  if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, Math.max(DELAY, wait)));
}
