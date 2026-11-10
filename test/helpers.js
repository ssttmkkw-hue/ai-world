import { loadConfig } from '../src/config.js';
import { Auth } from '../src/secrets.js';
import { Store } from '../src/db.js';
import { World } from '../src/world.js';
import { buildApp } from '../src/app.js';

export const TOKENS = {
  admin: 'test-admin-token-0123456789',
  a: 'test-agent-a-token-0123456789',
  b: 'test-agent-b-token-0123456789',
};

let keyN = 0;
export const newKey = () => `k-${process.pid}-${++keyN}`;

export function setup(env = {}) {
  const config = loadConfig({ RATE_ACTS_PER_MINUTE: '100', RATE_OPS_PER_HOUR: '1000', SNAPSHOT_EVERY_ACTS: '0', ...env });
  const auth = new Auth({
    admin: TOKENS.admin,
    agents: [
      { id: 'agent-a', name: 'Agent A', token: TOKENS.a },
      { id: 'agent-b', name: 'Agent B', token: TOKENS.b },
    ],
  });
  const store = new Store(':memory:');
  const clock = { t: Date.UTC(2026, 10, 10, 12, 0, 0) };
  const world = new World({ store, auth, config, now: () => clock.t });
  const app = buildApp({ world, auth });

  const act = (body, { token = TOKENS.a, key = newKey() } = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/act',
      headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) },
      payload: body,
    });
  const admin = (url, payload) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${TOKENS.admin}` }, payload: payload ?? {} });

  return { app, world, store, clock, act, admin };
}
