// Пуска локалния уеб app: `node server.mjs [--no-open]`, порт от `PORT` (8790).
import { spawn } from 'node:child_process';
import { createServer } from './src/http-server.mjs';
import { createLogger } from './src/log.mjs';

const log = createLogger();
const port = Number(process.env.PORT || 8790);
const app = createServer({ port, log });

let bound;
try {
  bound = await app.listen();
} catch (err) {
  log.error('server.listen_failed', { port, error: err });
  process.exit(1);
}

const url = `http://localhost:${bound}`;
log.info('server.started', { url });
if (!process.argv.includes('--no-open') && process.platform === 'darwin') {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info('server.stopping', { signal });
    await app.close();
    process.exit(0);
  });
}
