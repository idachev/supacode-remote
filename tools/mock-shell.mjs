// Истинският shell зад всеки таб на mock-а: node-pty, а без него — `script`, който също дава PTY.

import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './mock-log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** npm без одобрени install script-ове оставя spawn-helper без exec бит и posix_spawnp пада. */
function fixSpawnHelper() {
  const prebuilds = join(here, 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(prebuilds)) return;
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

let pty = null;
try {
  fixSpawnHelper();
  pty = require('node-pty');
} catch (e) {
  log('node-pty missing, using script', { error: String(e) });
}

/** С какво тръгват shell-овете — за реда „mock host listening“. */
export const shellKind = () => (pty ? 'node-pty' : 'script');

export function spawnShell(cols, rows) {
  const env = { ...process.env, TERM: 'xterm-256color', PS1: 'mock %~ %# ' };
  return pty ? ptyShell(cols, rows, env) : scriptShell(cols, rows, env);
}

function ptyShell(cols, rows, env) {
  const proc = pty.spawn('/bin/zsh', ['-f', '-i'], { name: 'xterm-256color', cols, rows, cwd: process.env.HOME, env });
  return {
    onData: (cb) => proc.onData((d) => cb(Buffer.from(d, 'utf8'))),
    onExit: (cb) => proc.onExit(cb),
    write: (buf) => proc.write(buf.toString('utf8')),
    resize: (c, r) => proc.resize(c, r),
    kill: () => proc.kill(),
  };
}

/** Резервният път: `script` дава PTY, а stty задава размера отвътре. */
function scriptShell(cols, rows, env) {
  const { spawn } = require('node:child_process');
  const proc = spawn('script', ['-q', '/dev/null', '/bin/zsh', '-c', `stty cols ${cols} rows ${rows}; exec /bin/zsh -f -i`],
    { env, cwd: process.env.HOME });
  return {
    onData: (cb) => { proc.stdout.on('data', cb); proc.stderr.on('data', cb); },
    onExit: (cb) => proc.on('exit', (code) => cb({ exitCode: code })),
    write: (buf) => proc.stdin.write(buf),
    resize: (c, r) => proc.stdin.write(`stty cols ${c} rows ${r}\n`),
    kill: () => proc.kill(),
  };
}
