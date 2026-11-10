// Пуска `tools/mock-host.mjs` на свободни портове, с LAN на 127.0.0.1. Иска `tools/node_modules`
// (`cd tools && npm install`).
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOCK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'mock-host.mjs');

export async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

export async function startMock({ lan = true, key = 'test-key' } = {}) {
  const port = await freePort();
  const lanPort = await freePort();
  const proc = spawn(process.execPath, [MOCK], {
    env: { ...process.env, PORT: String(port), LAN_PORT: String(lanPort), LAN_ADDRS: '127.0.0.1', LAN: lan ? '1' : '0', KEY: key },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock не тръгна:\n${log}`)), 15_000);
    const onData = (d) => {
      log += d.toString();
      const relayUp = log.includes('mock host on');
      const lanUp = !lan || log.includes('LAN endpoint on');
      if (relayUp && lanUp) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`mock спря (${code}):\n${log}`)));
  });
  proc.stdout.on('data', (d) => { log += d.toString(); });
  return {
    port, lanPort, key,
    connectionKey: `http://127.0.0.1:${port}/${key}`,
    settings: { baseUrl: `http://127.0.0.1:${port}`, apiKey: key },
    log: () => log,
    stop: () => new Promise((r) => {
      if (proc.exitCode !== null) return r();
      proc.once('exit', r);
      proc.kill();
    }),
  };
}

/** Чака, докато `predicate()` стане вярно; иначе грешка с описанието. */
export async function waitFor(predicate, what, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`не дочаках: ${what}`);
}
