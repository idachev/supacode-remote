// Локален mock на relay-а и на Supacode за проба на приложението без Mac и без Cloudflare.
//
// Говори протокола от docs/remote-access-protocol.md откъм страната на клиента: същият
// път `/client`, същата проверка на ключа (HTTP 401 преди upgrade), същото `relay` съобщение.
// Таб-овете са истински локални shell-ове през node-pty, за да се види как xterm.js рисува
// и как стигат клавишите.
//
// Пускане:  cd tools && npm install && node mock-host.mjs   (PORT=8787, KEY=test-key,
//           MOCK_NO_SECTIONS=1 за стария `list` без `sections`)
// Ключът за връзка от emulator-а: http://10.0.2.2:8787/test-key
//
// Специални редове, написани в кой да е таб (за ръчна проба):
//   mock-resize   — host-ът сменя размера на 100x30 и праща `size`;
//   mock-await    — агентът на този таб чака вход (`awaitingInput`), за известията;
//   mock-busy     — агентът пак работи (`busy`);
//   mock-offline  — host-ът „изчезва“ от relay-а за 5 s (`relay hostOnline:false`, после
//                   true), а WebSocket-ът на телефона остава; host-ът забравя attach-овете;
//   mock-lan-off  — LAN endpoint-ът спира (затваря LAN връзките), `hello` вече няма `lan`;
//   mock-lan-on   — LAN endpoint-ът тръгва пак.
//
// LAN пътят (раздел „LAN shortcut“ в протокола): ws://127.0.0.1:LAN_PORT/lan (8788), от
// emulator-а 10.0.2.2. Ръкостискане с nonce-и, HKDF-SHA256 върху клиентския ключ, HMAC
// доказателства и AES-256-GCM кадри. LAN=0 го изключва.

import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.KEY ?? 'test-key';
const LAN_PORT = Number(process.env.LAN_PORT ?? 8788);
const LAN_ADDRS = (process.env.LAN_ADDRS ?? '10.0.2.2').split(',');
let lanOn = process.env.LAN !== '0';
const COLS = 120;
const ROWS = 40;
const SCREEN_BUFFER_BYTES = 64 * 1024;

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
  log('node-pty липсва, ползвам `script`', String(e));
}

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

// ---- Данни за списъка: три repo-та, supacode с main + pinned + unpinned ----
// Празните незадължителни полета (`group`, `title`) се изпускат, както прави host-ът.

const repos = [
  {
    id: 'repo-supacode',
    name: 'supacode',
    worktrees: [
      {
        id: 'wt-main', name: 'main', branch: 'main', status: 'main', focused: false,
        working: false,
        tabs: [
          { id: 'tab-1', contentId: 'content-shell-main', title: 'zsh', focused: true, working: false,
            readOnly: false, agents: [] },
        ],
      },
      {
        id: 'wt-remote', name: 'remote-access', branch: 'remote-access', status: 'pinned', focused: true,
        title: 'Remote access', working: true,
        tabs: [
          { id: 'tab-2', contentId: 'content-claude', title: 'claude', focused: true, working: true,
            readOnly: false, agents: [{ agent: 'claude', activity: 'awaitingInput' }] },
          { id: 'tab-3', contentId: 'content-codex', title: 'codex review', focused: false, working: true,
            readOnly: false, agents: [{ agent: 'codex', activity: 'busy' }] },
        ],
      },
      {
        id: 'wt-picker', name: 'resume-picker', branch: 'feature/resume-picker', status: 'unpinned',
        focused: false, working: false,
        tabs: [
          { id: 'tab-4', contentId: 'content-idle', title: 'shell', focused: true, working: false,
            readOnly: false, agents: [{ agent: 'claude', activity: 'idle' }, { agent: 'codex', activity: 'error' }] },
          { id: 'tab-5', contentId: 'content-compact', title: 'compacting', focused: false, working: false,
            readOnly: true, agents: [{ agent: 'claude', activity: 'compacting' }] },
        ],
      },
    ],
  },
  {
    id: 'repo-notes',
    name: 'notes-app',
    group: 'Personal',
    worktrees: [
      {
        id: 'wt-notes-main', name: 'main', branch: 'main', status: 'main', focused: false,
        working: false,
        tabs: [
          { id: 'tab-6', contentId: 'content-notes', title: 'gradle', focused: true, working: false,
            readOnly: false, agents: [] },
        ],
      },
    ],
  },
  {
    id: 'repo-shop',
    name: 'web-shop',
    group: 'Work',
    worktrees: [
      {
        id: 'wt-shop-main', name: 'main', branch: 'main', status: 'main', focused: false,
        working: false,
        tabs: [
          { id: 'tab-7', contentId: 'content-shop-main', title: 'zsh', focused: true, working: false,
            readOnly: false, agents: [] },
        ],
      },
      {
        id: 'wt-shop-pin', name: 'billing', branch: 'feature/billing', status: 'pinned', focused: false,
        working: false,
        tabs: [
          { id: 'tab-8', contentId: 'content-shop-pin', title: 'claude', focused: true, working: false,
            readOnly: false, agents: [{ agent: 'claude', activity: 'idle' }] },
        ],
      },
    ],
  },
];

// Sidebar-ът на fork-а: Active (тече агент или script) над Pinned, после групите, после
// repository-тата без група. Вдигнатите в Active / Pinned редове ги няма в `rowIds`.
// MOCK_NO_SECTIONS=1 праща стария формат без `sections` и `rowIds`.
const rowIds = {
  'repo-supacode': ['wt-main', 'wt-picker'],
  'repo-notes': ['wt-notes-main'],
  'repo-shop': ['wt-shop-main'],
};
const sections = [
  { kind: 'active', title: 'Active', worktreeIds: ['wt-remote'] },
  { kind: 'pinned', title: 'Pinned', worktreeIds: ['wt-shop-pin'] },
  { kind: 'group', title: 'Work', collapsed: true, repositoryIds: ['repo-shop'] },
  { kind: 'group', title: 'Personal', repositoryIds: ['repo-notes'] },
  { kind: 'repository', repositoryId: 'repo-supacode' },
];
const withSections = process.env.MOCK_NO_SECTIONS !== '1';

function listMessage(id) {
  if (!withSections) return { t: 'list', id, repos };
  return { t: 'list', id, repos: repos.map((r) => ({ ...r, rowIds: rowIds[r.id] })), sections };
}

const knownContent = new Set(repos.flatMap((r) => r.worktrees.flatMap((w) => w.tabs.map((t) => t.contentId))));

// ---- Сесиите: един shell на contentId, жив между attach-овете, както zmx на Mac-а ----

/** contentId → { proc, cols, rows, screen: Buffer[], screenBytes, line } */
const sessions = new Map();
/** Всички свързани клиенти. */
const clients = new Set();
let hostOnline = true;

function spawnShell(cols, rows) {
  const env = { ...process.env, TERM: 'xterm-256color', PS1: 'mock %~ %# ' };
  if (pty) {
    const proc = pty.spawn('/bin/zsh', ['-f', '-i'], { name: 'xterm-256color', cols, rows, cwd: process.env.HOME, env });
    return {
      onData: (cb) => proc.onData((d) => cb(Buffer.from(d, 'utf8'))),
      onExit: (cb) => proc.onExit(cb),
      write: (buf) => proc.write(buf.toString('utf8')),
      resize: (c, r) => proc.resize(c, r),
      kill: () => proc.kill(),
    };
  }
  // Резервният път: `script` дава PTY, а stty задава размера отвътре.
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

function session(contentId) {
  let s = sessions.get(contentId);
  if (s) return s;
  const proc = spawnShell(COLS, ROWS);
  s = { proc, cols: COLS, rows: ROWS, screen: [], screenBytes: 0, line: '' };
  sessions.set(contentId, s);
  proc.onData((buf) => {
    s.screen.push(buf);
    s.screenBytes += buf.length;
    while (s.screenBytes > SCREEN_BUFFER_BYTES && s.screen.length > 1) s.screenBytes -= s.screen.shift().length;
    for (const c of clients) {
      if (c.attached === contentId) send(c, { t: 'out', contentId, b64: buf.toString('base64') });
    }
  });
  proc.onExit((e) => {
    log('shell end', contentId, JSON.stringify(e));
    sessions.delete(contentId);
    for (const c of clients) {
      if (c.attached === contentId) {
        c.attached = null;
        send(c, { t: 'detached', contentId, reason: 'session ended' });
      }
    }
  });
  return s;
}

/** Специалните редове от горния коментар; гледа се само какво е написано преди Enter. */
function watchLine(contentId, s, text) {
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') {
      const line = s.line.trim();
      s.line = '';
      if (line.endsWith('mock-resize')) {
        s.cols = 100; s.rows = 30;
        s.proc.resize(s.cols, s.rows);
        for (const c of clients) if (c.attached === contentId) send(c, { t: 'size', contentId, cols: s.cols, rows: s.rows });
      } else if (line.endsWith('mock-await') || line.endsWith('mock-busy')) {
        setActivity(contentId, line.endsWith('mock-await') ? 'awaitingInput' : 'busy');
      } else if (line.endsWith('mock-lan-off')) {
        setLan(false);
      } else if (line.endsWith('mock-lan-on')) {
        setLan(true);
      } else if (line.endsWith('mock-offline')) {
        setHostOnline(false);
        setTimeout(() => setHostOnline(true), 5000);
      }
    } else if (ch === '\u007f') {
      s.line = s.line.slice(0, -1);
    } else {
      s.line += ch;
    }
  }
}

/** Агентът на таба минава в това състояние; таб без агент получава `claude`. */
function setActivity(contentId, activity) {
  for (const repo of repos) for (const wt of repo.worktrees) for (const tab of wt.tabs) {
    if (tab.contentId !== contentId) continue;
    if (tab.agents.length === 0) tab.agents.push({ agent: 'claude', activity });
    tab.agents.forEach((a) => { a.activity = activity; });
    log('activity', contentId, activity);
  }
}

function setHostOnline(online) {
  hostOnline = online;
  log('hostOnline', online);
  for (const c of clients) {
    if (c.lan) continue; // LAN не минава през relay-а.
    if (!online) c.attached = null; // Host-ът си е отишъл — потоците му са спрели.
    send(c, { t: 'relay', hostOnline: online });
  }
}

function send(c, msg) {
  c.sendText(JSON.stringify(msg));
}

// ---- Съобщенията от клиента ----

function handle(c, msg) {
  if (!hostOnline && !c.lan) {
    send(c, { t: 'error', id: msg.id ?? null, message: 'host offline' });
    return;
  }
  switch (msg.t) {
    case 'hello':
      send(c, {
        t: 'hello', v: 1, host: 'Mock Mac',
        ...(lanOn && !c.lan ? { lan: { addrs: LAN_ADDRS, port: LAN_PORT } } : {}),
      });
      break;
    case 'list':
      send(c, listMessage(msg.id));
      break;
    case 'attach': {
      if (!knownContent.has(msg.contentId)) {
        send(c, { t: 'error', id: msg.id ?? null, message: `unknown content ${msg.contentId}` });
        break;
      }
      const s = session(msg.contentId);
      c.attached = msg.contentId;
      send(c, { t: 'attached', id: msg.id, contentId: msg.contentId, cols: s.cols, rows: s.rows });
      // Първото `out` е „текущият екран“: тук — последните байтове на shell-а.
      const screen = Buffer.concat(s.screen);
      send(c, { t: 'out', contentId: msg.contentId, b64: screen.toString('base64') });
      break;
    }
    case 'detach':
      if (c.attached === msg.contentId) c.attached = null;
      break;
    case 'input': {
      const s = sessions.get(msg.contentId);
      if (!s || c.attached !== msg.contentId) {
        send(c, { t: 'error', id: null, message: 'not attached' });
        break;
      }
      const bytes = Buffer.from(msg.b64, 'base64');
      const text = bytes.toString('utf8');
      log('input', msg.contentId, JSON.stringify(text), `hex=${bytes.toString('hex')}`);
      s.proc.write(bytes);
      watchLine(msg.contentId, s, text);
      break;
    }
    case 'suggest':
      setTimeout(() => send(c, {
        t: 'suggest', id: msg.id, contentId: msg.contentId,
        suggestions: ['git status', 'echo здравей 👋', 'ls -la'],
      }), 2000);
      break;
    default:
      send(c, { t: 'error', id: msg.id ?? null, message: `unknown type ${msg.t}` });
  }
}

// ---- HTTP + WebSocket ----

const server = createServer((req, res) => {
  res.writeHead(404).end('not found');
});
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path !== '/client') {
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    log('401', req.socket.remoteAddress);
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  const c = {
    ws, attached: null, lan: false, id: Math.random().toString(16).slice(2, 10),
    sendText: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
  };
  clients.add(c);
  log('connect', c.id);
  send(c, { t: 'relay', hostOnline });
  ws.on('message', (data) => {
    const text = data.toString('utf8');
    if (text === 'ping') { ws.send('pong'); return; }
    let msg;
    try { msg = JSON.parse(text); } catch { log('bad json', text); return; }
    if (msg.t !== 'input' && msg.t !== 'list') log('<-', c.id, text.slice(0, 200));
    handle(c, msg);
  });
  ws.on('close', () => { clients.delete(c); log('close', c.id); });
});

// ---- LAN endpoint ----

const LAN_INFO = Buffer.from('supacode-lan-v1');
const C2S = Buffer.from('c2s\0', 'binary');
const S2C = Buffer.from('s2c\0', 'binary');
const lanWss = new WebSocketServer({ noServer: true });
let lanServer = null;

function lanNonce(direction, counter) {
  const n = Buffer.alloc(12);
  direction.copy(n, 0);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}

lanWss.on('connection', (ws) => {
  const c = { ws, attached: null, lan: true, id: 'lan-' + Math.random().toString(16).slice(2, 8), state: 'hello' };
  let keys = null;
  let sendCounter = 0;
  let recvCounter = 0;
  const close = (why) => { log('lan close', c.id, why); ws.terminate(); };
  c.sendText = (text) => {
    if (ws.readyState !== ws.OPEN) return;
    const nonce = lanNonce(S2C, sendCounter++);
    const cipher = crypto.createCipheriv('aes-256-gcm', keys.s2c, nonce);
    ws.send(Buffer.concat([nonce, cipher.update(Buffer.from(text, 'utf8')), cipher.final(), cipher.getAuthTag()]));
  };
  ws.on('message', (data, isBinary) => {
    if (c.state === 'hello' || c.state === 'auth') {
      if (isBinary) return close('binary before auth');
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return close('bad json'); }
      if (c.state === 'hello') {
        const clientNonce = Buffer.from(msg.nonce ?? '', 'base64');
        if (msg.t !== 'lan.hello' || clientNonce.length !== 16) return close('bad hello');
        const macNonce = crypto.randomBytes(16);
        const okm = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(KEY, 'utf8'), Buffer.concat([clientNonce, macNonce]), LAN_INFO, 96));
        keys = { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64), proof: okm.subarray(64, 96) };
        const proof = crypto.createHmac('sha256', keys.proof).update('mac').digest('base64');
        ws.send(JSON.stringify({ t: 'lan.hello', v: 1, nonce: macNonce.toString('base64'), proof }));
        c.state = 'auth';
        return;
      }
      const expected = crypto.createHmac('sha256', keys.proof).update('client').digest();
      const got = Buffer.from(msg.proof ?? '', 'base64');
      if (msg.t !== 'lan.auth' || got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
        return close('bad proof');
      }
      c.state = 'ready';
      clients.add(c);
      log('lan connect', c.id);
      return;
    }
    if (!isBinary || data.length < 28) return close('not a frame');
    const nonce = data.subarray(0, 12);
    if (!nonce.subarray(0, 4).equals(C2S) || nonce.readBigUInt64BE(4) !== BigInt(recvCounter)) return close('bad nonce');
    let text;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', keys.c2s, nonce);
      decipher.setAuthTag(data.subarray(data.length - 16));
      text = Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString('utf8');
    } catch { return close('bad tag'); }
    recvCounter++;
    if (text === 'ping') { c.sendText('pong'); return; }
    let msg;
    try { msg = JSON.parse(text); } catch { return close('bad json'); }
    if (msg.t !== 'input' && msg.t !== 'list') log('<- lan', c.id, text.slice(0, 200));
    handle(c, msg);
  });
  ws.on('close', () => { clients.delete(c); log('lan close', c.id); });
});

function startLan() {
  lanServer = createServer((req, res) => res.writeHead(404).end('not found'));
  lanServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/lan') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    lanWss.handleUpgrade(req, socket, head, (ws) => lanWss.emit('connection', ws));
  });
  lanServer.listen(LAN_PORT, '127.0.0.1', () => log(`LAN endpoint on ws://127.0.0.1:${LAN_PORT}/lan  addrs=${LAN_ADDRS}`));
}

function setLan(on) {
  if (on === lanOn) return;
  lanOn = on;
  log('lan', on ? 'on' : 'off');
  if (on) {
    startLan();
  } else {
    for (const c of clients) if (c.lan) c.ws.terminate();
    lanServer?.close();
    lanServer = null;
  }
}

if (lanOn) startLan();

server.listen(PORT, '127.0.0.1', () => log(`mock host on http://127.0.0.1:${PORT}  emulator connection key: http://10.0.2.2:${PORT}/${KEY}  pty=${pty ? 'node-pty' : 'script'}`));
