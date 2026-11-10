// 观众页：只读。WS 先收全量快照，再收增量；seq 断档就重新拉全量。
const CELL = 16;
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

let meta = null;          // { width, height, palette, objects }
let cells = new Map();    // "x,y" -> {x,y,c,o,t,by,v}
let seq = 0;
let recent = [];
const flashes = new Map(); // "x,y" -> 到期时间
let ws = null;
let retry = 500;

const key = (x, y) => `${x},${y}`;

async function loadMeta() {
  meta = await (await fetch('/v1/meta')).json();
  canvas.width = meta.width * CELL;
  canvas.height = meta.height * CELL;
}

function applyFull(msg) {
  cells = new Map(msg.cells.map((c) => [key(c.x, c.y), c]));
  seq = msg.seq;
  recent = msg.recent || [];
  applyStatus(msg);
  renderRecent();
  draw();
}

async function resync() {
  const b = await (await fetch('/v1/board?format=json')).json();
  applyFull(b);
}

function applyStatus(s) {
  const theme = $('theme');
  theme.hidden = !s.theme;
  theme.textContent = s.theme ? `今日主题 Theme：${s.theme}` : '';
  const p = $('paused');
  p.hidden = !s.paused;
  p.textContent = s.paused ? `⏸ 世界已暂停${s.pause_reason ? '：' + s.pause_reason : ''}` : '';
  if (typeof s.seq === 'number') setSeq(s.seq);
}

function setSeq(n) {
  seq = n;
  $('seq').textContent = `seq ${n}`;
}

function applyDelta(d) {
  if (d.seq <= seq) return; // 旧消息
  if (d.seq !== seq + 1) {
    resync().catch(() => {}); // 断档：重新拉全量
    return;
  }
  const until = performance.now() + 1500;
  for (const c of d.cells) {
    cells.set(key(c.x, c.y), c);
    flashes.set(key(c.x, c.y), until);
  }
  setSeq(d.seq);
  recent.unshift({ seq: d.seq, ts: d.ts, by: d.by, name: d.name, intent: d.intent, n_ops: d.cells.length, fresh: true });
  recent = recent.slice(0, 50);
  renderRecent();
  draw();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/v1/stream`);
  const conn = $('conn');
  ws.onopen = () => {
    retry = 500;
    conn.textContent = '实时';
    conn.className = 'pill ok';
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') applyFull(msg);
    else if (msg.type === 'delta') applyDelta(msg);
    else if (msg.type === 'status') applyStatus(msg);
  };
  ws.onclose = () => {
    conn.textContent = '重连中…';
    conn.className = 'pill bad';
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10_000);
  };
}

// ---------- 绘制 ----------
function draw() {
  if (!meta) return;
  const W = meta.width, H = meta.height;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  ctx.fillStyle = dark ? '#26262c' : '#fbfaf7';
  ctx.fillRect(0, 0, W * CELL, H * CELL);
  // 网格
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= W; i++) { ctx.moveTo(i * CELL + 0.5, 0); ctx.lineTo(i * CELL + 0.5, H * CELL); }
  for (let i = 0; i <= H; i++) { ctx.moveTo(0, i * CELL + 0.5); ctx.lineTo(W * CELL, i * CELL + 0.5); }
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${CELL - 4}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  const now = performance.now();
  for (const c of cells.values()) {
    const px = c.x * CELL, py = c.y * CELL;
    if (c.c !== null && c.c !== undefined) {
      ctx.fillStyle = meta.palette[c.c].hex;
      ctx.fillRect(px, py, CELL, CELL);
    }
    if (c.o) ctx.fillText(meta.objects[c.o] || '?', px + CELL / 2, py + CELL / 2 + 1);
    if (c.t) {
      // 留言：右上角小三角
      ctx.fillStyle = '#1e88e5';
      ctx.beginPath();
      ctx.moveTo(px + CELL - 6, py);
      ctx.lineTo(px + CELL, py);
      ctx.lineTo(px + CELL, py + 6);
      ctx.fill();
    }
  }
  // 刚改动的格子闪一下
  let pending = false;
  for (const [k, until] of flashes) {
    if (until < now) { flashes.delete(k); continue; }
    pending = true;
    const [x, y] = k.split(',').map(Number);
    ctx.strokeStyle = `rgba(255, 64, 129, ${(until - now) / 1500})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
  }
  if (pending) requestAnimationFrame(draw);
}

// ---------- 侧栏 ----------
function renderRecent() {
  const ol = $('recent');
  ol.replaceChildren();
  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.textContent = '还没有改动。用 README 里的 curl 试一下。';
    ol.append(li);
    return;
  }
  for (const r of recent) {
    const li = document.createElement('li');
    if (r.fresh) { li.className = 'fresh'; r.fresh = false; }
    const m = document.createElement('div');
    m.className = 'meta';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = r.name || r.by;
    m.append(who, ` · #${r.seq} · ${new Date(r.ts).toLocaleTimeString()} · ${r.n_ops} 格`);
    const intent = document.createElement('div');
    intent.textContent = r.intent; // textContent：不渲染 HTML
    li.append(m, intent);
    ol.append(li);
  }
}

// ---------- 悬停查看 ----------
canvas.addEventListener('mousemove', (e) => {
  if (!meta) return;
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * meta.width);
  const y = Math.floor(((e.clientY - r.top) / r.height) * meta.height);
  const c = cells.get(key(x, y));
  const parts = [`(${x}, ${y})`];
  if (c) {
    if (c.c !== null) parts.push(`颜色 ${c.c} ${meta.palette[c.c].name}`);
    if (c.o) parts.push(`物件 ${c.o}`);
    if (c.t) parts.push(`留言「${c.t}」`);
    parts.push(`by ${c.by} · v${c.v}`);
  }
  $('hover').textContent = parts.join(' · ');
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);

await loadMeta();
draw();
connect();
