// Пуска локалния уеб app: `node server.mjs [--no-open]`, порт от `PORT` (8790).
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInfo } from './src/build-info.mjs';
import { createServer } from './src/http-server.mjs';
import { createLogger } from './src/log.mjs';

const log = createLogger();
const port = Number(process.env.PORT || 8790);
const build = readBuildInfo({ cwd: dirname(fileURLToPath(import.meta.url)) });
const app = createServer({ port, log, build });

let bound;
try {
  bound = await app.listen();
} catch (err) {
  log.error('server.listen_failed', { port, error: err });
  process.exit(1);
}

const url = `http://localhost:${bound}`;
log.info('server.started', { url, sha: build.sha, dirty: build.dirty });
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
