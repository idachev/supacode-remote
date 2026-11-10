// Пуска локалния уеб app: `node server.mjs [--no-open]`, порт от `PORT` (8790).
import { spawn } from 'node:child_process';
import { createServer } from './src/http-server.mjs';

const port = Number(process.env.PORT || 8790);
const app = createServer({ port });

let bound;
try {
  bound = await app.listen();
} catch (err) {
  console.error(`Не мога да слушам на 127.0.0.1:${port}: ${err.message}`);
  process.exit(1);
}

const url = `http://localhost:${bound}`;
console.log(`Supacode Remote (уеб) на ${url}  — Ctrl+C спира.`);
if (!process.argv.includes('--no-open') && process.platform === 'darwin') {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await app.close();
    process.exit(0);
  });
}
