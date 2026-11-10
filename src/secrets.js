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

export function newToken() {
  return 'aiw_' + randomBytes(24).toString('base64url');
}

export function parseAgentTokens(spec) {
  const agents = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, name, token] = part.split(':');
    if (!ID_RE.test(id || '') || !name || !token || token.length < 16) {
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
  return { admin, agents, generatedPath, file };
}

const h = (t) => createHash('sha256').update(String(t)).digest();

export class Auth {
  constructor({ admin, agents }) {
    this.adminHash = h(admin);
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
    return !!t && timingSafeEqual(h(t), this.adminHash);
  }

  name(id) {
    if (id === 'admin') return 'Admin';
    return this.byId.get(id)?.name || id;
  }
}
