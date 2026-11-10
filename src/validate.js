// 请求校验与文本过滤。所有来自 agent 的文本都按不可信内容处理。
import {
  WIDTH, HEIGHT, PALETTE, OBJECTS, MAX_OPS_PER_ACT, MAX_INTENT_LEN, MAX_TEXT_LEN,
} from './config.js';

const LAYERS = ['color', 'object', 'text', 'all'];
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|ru|cn|top)\b)/i;
// 控制字符、零宽字符、双向控制字符
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** 清洗文本：去控制字符、合并空白、按码点计长度。返回 { value } 或 { error }。 */
export function cleanText(raw, { max, field, blocklist = [], allowEmpty = false }) {
  if (typeof raw !== 'string') return { error: `${field} must be a string` };
  const value = raw.replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim().normalize('NFC');
  if (!value && !allowEmpty) return { error: `${field} must not be empty` };
  const len = [...value].length;
  if (len > max) return { error: `${field} too long (${len} > ${max} chars)` };
  if (URL_RE.test(value)) return { error: `${field} must not contain links` };
  const lower = value.toLowerCase();
  const hit = blocklist.find((w) => lower.includes(w));
  if (hit) return { error: `${field} contains a blocked word` };
  return { value };
}

function parseColor(c) {
  if (Number.isInteger(c) && c >= 0 && c < PALETTE.length) return c;
  if (typeof c === 'string') {
    const i = PALETTE.findIndex((p) => p.name === c.toLowerCase());
    if (i >= 0) return i;
  }
  return null;
}

/**
 * 校验 act 请求体。返回 { intent, ops } 或 { errors: [{i?, message}] }。
 * 归一化后的 op：{ op, x, y, color?, object?, text?, layer?, if_v? }
 */
export function validateAct(body, { blocklist = [] } = {}) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ message: 'body must be a JSON object' }] };
  }
  const intent = cleanText(body.intent, { max: MAX_INTENT_LEN, field: 'intent', blocklist });
  if (intent.error) errors.push({ message: intent.error });

  const ops = body.ops;
  if (!Array.isArray(ops) || ops.length === 0) {
    errors.push({ message: 'ops must be a non-empty array' });
    return { errors };
  }
  if (ops.length > MAX_OPS_PER_ACT) {
    errors.push({ message: `too many ops (${ops.length} > ${MAX_OPS_PER_ACT})` });
    return { errors };
  }

  const out = [];
  ops.forEach((raw, i) => {
    const err = (message) => errors.push({ i, message });
    if (!raw || typeof raw !== 'object') return err('op must be an object');
    const { op, x, y } = raw;
    if (!['paint', 'place', 'write', 'clear'].includes(op)) return err('op must be paint|place|write|clear');
    if (!Number.isInteger(x) || x < 0 || x >= WIDTH) return err(`x must be an integer 0..${WIDTH - 1}`);
    if (!Number.isInteger(y) || y < 0 || y >= HEIGHT) return err(`y must be an integer 0..${HEIGHT - 1}`);
    const n = { op, x, y };
    if (raw.if_v !== undefined) {
      if (!Number.isInteger(raw.if_v) || raw.if_v < 0) return err('if_v must be a non-negative integer');
      n.if_v = raw.if_v;
    }
    if (op === 'paint') {
      const c = parseColor(raw.color);
      if (c === null) return err(`color must be a palette index 0..${PALETTE.length - 1} or a palette name`);
      n.color = c;
    } else if (op === 'place') {
      if (typeof raw.object !== 'string' || !Object.hasOwn(OBJECTS, raw.object)) {
        return err(`object must be one of: ${Object.keys(OBJECTS).join(', ')}`);
      }
      n.object = raw.object;
    } else if (op === 'write') {
      const t = cleanText(raw.text, { max: MAX_TEXT_LEN, field: 'text', blocklist });
      if (t.error) return err(t.error);
      n.text = t.value;
    } else if (op === 'clear') {
      const layer = raw.layer ?? 'all';
      if (!LAYERS.includes(layer)) return err('layer must be color|object|text|all');
      n.layer = layer;
    }
    out.push(n);
  });

  if (errors.length) return { errors };
  return { intent: intent.value, ops: out };
}
