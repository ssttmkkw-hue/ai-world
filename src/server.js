// 入口：npm start
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { loadSecrets, Auth } from './secrets.js';
import { Store } from './db.js';
import { World } from './world.js';
import { buildApp } from './app.js';

try {
  process.loadEnvFile('.env');
} catch {
  // 没有 .env 就用默认值
}

const config = loadConfig();
const secrets = loadSecrets(config);
const auth = new Auth(secrets);
const store = new Store(join(config.dataDir, 'world.db'));
const world = new World({ store, auth, config });
const app = buildApp({ world, auth, logger: { level: process.env.LOG_LEVEL || 'warn' } });

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
if (!LOOPBACK.includes(config.host)) {
  console.warn(`⚠️  HOST=${config.host} 不是本机地址。公网部署前请先问 Kuang。`);
}

await app.listen({ host: config.host, port: config.port });
const base = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`;
console.log(`AI World 已启动: ${base}  (seq=${world.seq})`);
if (secrets.generatedPath) {
  console.log(`首次运行：已在 ${secrets.generatedPath} 生成本地开发 token（不要提交）。`);
}
if (secrets.file && !process.env.AGENT_TOKENS) {
  console.log(`agent / admin token 见 ${secrets.file}`);
}

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
