// 身份与 token。管理员预置，不开放注册。
// 优先级：环境变量 ADMIN_TOKEN / AGENT_TOKENS > data/secrets.json（首次运行时本地生成，不进 git）。
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_AGENTS = [
  { id: 'claude-1', name: 'Claude' },
  { id: 'codex-1', name: 'Codex' },
  { id: 'cursor-1', name: 'Cursor' },
  { id: 'bot-1', name: 'TestBot' },
];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MIN_TOKEN_LEN = 16;
const RESERVED_IDS = new Set(['admin']);

export function newToken() {
  return 'aiw_' + randomBytes(24).toString('base64url');
}

export function parseAgentTokens(spec) {
  const agents = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, name, token] = part.split(':');
    if (!ID_RE.test(id || '') || !name || !token || token.length < MIN_TOKEN_LEN) {
      throw new Error(`AGENT_TOKENS 格式错误（需要 id:显示名:token，token ≥16 字符）: ${id || part.slice(0, 8)}`);
    }
    agents.push({ id, name: name.slice(0, 32), token });
  }
  return agents;
}

/** 读取或生成 secrets。返回 { admin, agents, generatedPath? } */
export function loadSecrets(config) {
  const file = join(config.dataDir, 'secrets.json');
  let fromFile = null;
  let generatedPath = null;
  const needFile = !config.adminToken || !config.agentTokens;
  if (needFile) {
    if (existsSync(file)) {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } else {
      mkdirSync(config.dataDir, { recursive: true });
      fromFile = {
        note: 'Local dev tokens generated on first run. Do NOT commit this file.',
        admin: newToken(),
        agents: DEFAULT_AGENTS.map((a) => ({ ...a, token: newToken() })),
      };
      writeFileSync(file, JSON.stringify(fromFile, null, 2) + '\n', { mode: 0o600 });
      generatedPath = file;
    }
  }
  const admin = config.adminToken || fromFile.admin;
  const agents = config.agentTokens ? parseAgentTokens(config.agentTokens) : fromFile.agents;
  const { warnings } = checkSecrets({ admin, agents }, config.agentTokens ? 'AGENT_TOKENS' : file);
  // 管理员 token 太短或与 agent 共用时，禁用管理接口（而不是让服务起不来）
  const adminOk = !warnings.some((w) => w.disablesAdmin);
  return { admin: adminOk ? admin : null, agents, generatedPath, file, warnings: warnings.map((w) => w.message) };
}

/**
 * 校验凭据。结构错误、agent token 太短、重复 id/token 直接抛错；
 * 管理员 token 的问题只禁用管理接口并给出警告。
 */
export function checkSecrets({ admin, agents }, source = 'secrets') {
  if (!Array.isArray(agents) || agents.length === 0) throw new Error(`${source}: agents 必须是非空数组`);
  const ids = new Set();
  const tokens = new Set();
  for (const a of agents) {
    if (!a || typeof a !== 'object') throw new Error(`${source}: agent 条目格式错误`);
    if (typeof a.id !== 'string' || !ID_RE.test(a.id) || RESERVED_IDS.has(a.id)) {
      throw new Error(`${source}: agent id 不合法: ${String(a.id).slice(0, 32)}`);
    }
    if (typeof a.name !== 'string' || !a.name.trim()) throw new Error(`${source}: agent ${a.id} 缺少显示名`);
    if (typeof a.token !== 'string' || a.token.length < MIN_TOKEN_LEN || /\s/.test(a.token)) {
      throw new Error(`${source}: agent ${a.id} 的 token 必须 ≥${MIN_TOKEN_LEN} 字符且不含空白`);
    }
    if (ids.has(a.id)) throw new Error(`${source}: agent id 重复: ${a.id}`);
    if (tokens.has(a.token)) throw new Error(`${source}: 多个 agent 共用同一个 token（${a.id}）`);
    ids.add(a.id);
    tokens.add(a.token);
  }
  const warnings = [];
  if (typeof admin !== 'string' || admin.length < MIN_TOKEN_LEN || /\s/.test(admin)) {
    warnings.push({ disablesAdmin: true, message: `ADMIN_TOKEN 必须 ≥${MIN_TOKEN_LEN} 字符且不含空白；管理接口已禁用` });
  } else if (tokens.has(admin)) {
    warnings.push({ disablesAdmin: true, message: 'ADMIN_TOKEN 与某个 agent token 相同；管理接口已禁用' });
  }
  return { warnings };
}

const h = (t) => createHash('sha256').update(String(t)).digest();

export class Auth {
  constructor({ admin, agents }) {
    this.adminHash = admin ? h(admin) : null; // null = 管理接口禁用
    this.byHash = new Map();
    this.byId = new Map();
    for (const a of agents) {
      this.byHash.set(h(a.token).toString('hex'), { id: a.id, name: a.name });
      this.byId.set(a.id, { id: a.id, name: a.name });
    }
  }

  static bearer(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    return m ? m[1] : null;
  }

  agent(req) {
    const t = Auth.bearer(req);
    return t ? this.byHash.get(h(t).toString('hex')) || null : null;
  }

  isAdmin(req) {
    const t = Auth.bearer(req);
    return !!t && !!this.adminHash && timingSafeEqual(h(t), this.adminHash);
  }

  name(id) {
    if (id === 'admin') return 'Admin';
    return this.byId.get(id)?.name || id;
  }
}
