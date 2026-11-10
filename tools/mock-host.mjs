// Локален mock на relay-а и на Supacode за проба на приложението без Mac и без Cloudflare.
//
// Говори протокола от docs/remote-access-protocol.md откъм страната на клиента: същият
// път `/client`, същата проверка на ключа (HTTP 401 преди upgrade), същото `relay` съобщение.
// Таб-овете са истински локални shell-ове през node-pty, за да се види как xterm.js рисува
// и как стигат клавишите.
//
// Пускане:  cd tools && npm install && node mock-host.mjs   (PORT=8787, KEY=test-key,
//           MOCK_NO_SECTIONS=1 за стария `list` без `sections`,
//           MOCK_OLD_RELAY=1 за стар relay — един Mac, `relay` без `hosts` и `host`,
//           MOCK_LEGACY=1 за още един онлайн Mac `default` без име — стар Supacode)
//
// Няколко Mac-а (раздел „Multiple hosts“ в протокола): „Office Mac“ (repo-тата по-долу и LAN),
// „Home Mac“ (свои repo-та и contentId-та) и „Mac mini“ (извън линия). `/client?host=<id>`
// връзва връзката към този Mac; без `host` тя е несвързана — получава само списъка, а всяка
// заявка — `host offline`.
// Ключът за връзка от emulator-а: http://10.0.2.2:8787/test-key
//
// Специални редове, написани в кой да е таб (за ръчна проба):
//   mock-resize   — host-ът сменя размера на 100x30 и праща `size`;
//   mock-await    — агентът на този таб чака вход (`awaitingInput`), за известията;
//   mock-busy     — агентът пак работи (`busy`);
//   mock-offline  — host-ът „изчезва“ от relay-а за 5 s (`relay hostOnline:false`, после
//                   true), а WebSocket-ът на телефона остава; host-ът забравя attach-овете;
//   mock-lan-off  — LAN endpoint-ът спира (затваря LAN връзките), `hello` вече няма `lan`;
//   mock-lan-on   — LAN endpoint-ът тръгва пак;
//   mock-rename   — свързаният Mac сменя името си (и обратно), relay-ят праща новия списък;
//   mock-other-off / mock-other-on — другият Mac с repo-та („Home Mac“ или „Office Mac“)
//                   излиза от линия / се връща; вързаните към него виждат ръба.
//
// LAN пътят (раздел „LAN shortcut“ в протокола): wss://127.0.0.1:LAN_PORT/lan (8788), от
// emulator-а 10.0.2.2. TLS 1.3 със самоподписан сертификат от паметта, `fp` и `fpMac` в
// `hello`. LAN=0 го изключва.

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
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

const officeRepos = [
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
const oldRelay = process.env.MOCK_OLD_RELAY === '1';

const homeRepos = [
  {
    id: 'repo-dotfiles',
    name: 'dotfiles',
    worktrees: [
      {
        id: 'wt-dot-main', name: 'main', branch: 'main', status: 'main', focused: true, working: false,
        tabs: [
          { id: 'tab-h1', contentId: 'home-shell', title: 'zsh', focused: true, working: false,
            readOnly: false, agents: [] },
          { id: 'tab-h2', contentId: 'home-claude', title: 'claude', focused: false, working: true,
            readOnly: false, agents: [{ agent: 'claude', activity: 'busy' }] },
        ],
      },
    ],
  },
];

function makeHost(id, name, online, hostRepos, extra = {}) {
  return {
    id, name, originalName: name, online, repos: hostRepos, sessions: new Map(), lan: false,
    knownContent: new Set(hostRepos.flatMap((r) => r.worktrees.flatMap((w) => w.tabs.map((t) => t.contentId)))),
    ...extra,
  };
}

/** hostId → Mac. Id-тата приличат на истинските (16 hex), за да се видят в лога. */
const hosts = new Map();
for (const h of [
  makeHost('0f1ce0ff1ce0ff1c', 'Office Mac', true, officeRepos, { lan: true, rowIds, sections }),
  makeHost('40be40be40be40be', 'Home Mac', true, homeRepos),
  makeHost('3a1a3a1a3a1a3a1a', 'Mac mini', false, []),
]) hosts.set(h.id, h);
if (process.env.MOCK_LEGACY === '1') hosts.set('default', makeHost('default', undefined, true, homeRepos.map((r) => ({ ...r, id: 'legacy-' + r.id }))));
const officeHost = hosts.get('0f1ce0ff1ce0ff1c');

function listMessage(host, id) {
  if (!withSections || !host.sections) return { t: 'list', id, repos: host.repos };
  return { t: 'list', id, repos: host.repos.map((r) => ({ ...r, rowIds: host.rowIds[r.id] })), sections: host.sections };
}

/** Списъкът, както го подрежда relay-ят: по име без значение на главни букви, без име накрая, после по id. */
function hostList() {
  return [...hosts.values()]
    .map((h) => ({ id: h.id, ...(h.name ? { name: h.name } : {}), online: h.online }))
    .sort((a, b) => {
      if (!a.name !== !b.name) return a.name ? -1 : 1;
      const byName = (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase());
      return byName || a.id.localeCompare(b.id);
    });
}

/** `relay` за един клиент: своят `host` и `hostOnline`, общ списък. */
function relayMessage(c) {
  const host = hosts.get(c.hostId);
  const hostOnline = Boolean(host?.online);
  if (oldRelay) return { t: 'relay', hostOnline };
  return { t: 'relay', hostOnline, ...(c.hostId ? { host: c.hostId } : {}), hosts: hostList() };
}

function broadcastRelay() {
  for (const c of clients) if (!c.lan) send(c, relayMessage(c));
}

// ---- Сесиите: един shell на contentId, жив между attach-овете, както zmx на Mac-а ----

/** Всички свързани клиенти; `c.hostId` е Mac-ът, към който е вързан (`null` — несвързан). */
const clients = new Set();

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

/** Сесиите са по Mac (`host.sessions`: contentId → { proc, cols, rows, screen, screenBytes, line }). */
function session(host, contentId) {
  const sessions = host.sessions;
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
      if (c.hostId === host.id && c.attached === contentId) send(c, { t: 'out', contentId, b64: buf.toString('base64') });
    }
  });
  proc.onExit((e) => {
    log('shell end', host.id, contentId, JSON.stringify(e));
    sessions.delete(contentId);
    for (const c of clients) {
      if (c.hostId === host.id && c.attached === contentId) {
        c.attached = null;
        send(c, { t: 'detached', contentId, reason: 'session ended' });
      }
    }
  });
  return s;
}

/** Специалните редове от горния коментар; гледа се само какво е написано преди Enter. */
function watchLine(host, contentId, s, text) {
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') {
      const line = s.line.trim();
      s.line = '';
      if (line.endsWith('mock-resize')) {
        s.cols = 100; s.rows = 30;
        s.proc.resize(s.cols, s.rows);
        for (const c of clients) {
          if (c.hostId === host.id && c.attached === contentId) send(c, { t: 'size', contentId, cols: s.cols, rows: s.rows });
        }
      } else if (line.endsWith('mock-await') || line.endsWith('mock-busy')) {
        setActivity(host, contentId, line.endsWith('mock-await') ? 'awaitingInput' : 'busy');
      } else if (line.endsWith('mock-rename')) {
        host.name = host.name === host.originalName ? `${host.originalName} (нов)` : host.originalName;
        log('rename', host.id, host.name);
        broadcastRelay();
      } else if (line.endsWith('mock-other-off') || line.endsWith('mock-other-on')) {
        const other = [...hosts.values()].find((h) => h !== host && h.repos.length > 0 && h.id !== 'default');
        if (other) setHostOnline(other, line.endsWith('mock-other-on'));
      } else if (line.endsWith('mock-lan-off')) {
        setLan(false);
      } else if (line.endsWith('mock-lan-on')) {
        setLan(true);
      } else if (line.endsWith('mock-offline')) {
        setHostOnline(host, false);
        setTimeout(() => setHostOnline(host, true), 5000);
      }
    } else if (ch === '\u007f') {
      s.line = s.line.slice(0, -1);
    } else {
      s.line += ch;
    }
  }
}

/** Агентът на таба минава в това състояние; таб без агент получава `claude`. */
function setActivity(host, contentId, activity) {
  for (const repo of host.repos) for (const wt of repo.worktrees) for (const tab of wt.tabs) {
    if (tab.contentId !== contentId) continue;
    if (tab.agents.length === 0) tab.agents.push({ agent: 'claude', activity });
    tab.agents.forEach((a) => { a.activity = activity; });
    log('activity', contentId, activity);
  }
}

function setHostOnline(host, online) {
  host.online = online;
  log('hostOnline', host.id, online);
  for (const c of clients) {
    if (c.lan || c.hostId !== host.id) continue; // LAN не минава през relay-а.
    if (!online) c.attached = null; // Host-ът си е отишъл — потоците му са спрели.
  }
  // Вързаните към него виждат ръба, другите — само новия списък.
  broadcastRelay();
}

function send(c, msg) {
  c.sendText(JSON.stringify(msg));
}

// ---- Съобщенията от клиента ----

function handle(c, msg) {
  const host = hosts.get(c.hostId);
  if (!host || (!host.online && !c.lan)) {
    send(c, { t: 'error', id: msg.id ?? null, message: 'host offline' });
    return;
  }
  switch (msg.t) {
    case 'hello':
      send(c, {
        // Стар Supacode (`default`) не знае своя hostId.
        t: 'hello', v: 1, host: host.name ?? 'Mac', ...(host.id === 'default' ? {} : { hostId: host.id }),
        ...(host.lan && lanOn && !c.lan ? { lan: { addrs: LAN_ADDRS, port: LAN_PORT, fp: LAN_FP, fpMac: LAN_FP_MAC } } : {}),
      });
      break;
    case 'list':
      send(c, listMessage(host, msg.id));
      break;
    case 'attach': {
      if (!host.knownContent.has(msg.contentId)) {
        send(c, { t: 'error', id: msg.id ?? null, message: `unknown content ${msg.contentId}` });
        break;
      }
      const s = session(host, msg.contentId);
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
      const s = host.sessions.get(msg.contentId);
      if (!s || c.attached !== msg.contentId) {
        send(c, { t: 'error', id: null, message: 'not attached' });
        break;
      }
      const bytes = Buffer.from(msg.b64, 'base64');
      const text = bytes.toString('utf8');
      log('input', host.id, msg.contentId, JSON.stringify(text), `hex=${bytes.toString('hex')}`);
      s.proc.write(bytes);
      watchLine(host, msg.contentId, s, text);
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
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  if (path !== '/client') {
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    log('401', req.socket.remoteAddress);
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  // Както relay-ят: след ключа, преди upgrade-а (РЛ6). Непознат, но валиден id се връзва (офлайн).
  const hostId = url.searchParams.get('host');
  if (hostId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\n\r\nbad host id');
    return;
  }
  // Стар relay не знае `host`: всички са при единствения Mac.
  const bound = oldRelay ? officeHost.id : hostId;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, bound));
});

wss.on('connection', (ws, hostId) => {
  const c = {
    ws, attached: null, lan: false, hostId, id: Math.random().toString(16).slice(2, 10),
    sendText: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
  };
  clients.add(c);
  log('connect', c.id, 'host=' + (hostId ?? '(несвързан)'));
  send(c, relayMessage(c));
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
//
// wss://127.0.0.1:LAN_PORT/lan с TLS 1.3 и самоподписан сертификат, създаден в паметта при
// всяко пускане (пакетът `selfsigned`; нищо не се пише на диска). `fp` е SHA-256 на DER
// байтовете на сертификата, `fpMac` — HMAC-SHA256 с клиентския ключ върху
// "supacode-lan-fp-v1:" + fp. След upgrade-а съобщенията са същият текст като по relay-а.

const lanIdentity = selfsigned.generate([{ name: 'commonName', value: 'supacode-mock-lan' }], {
  keySize: 2048, days: 3650, algorithm: 'sha256',
});
const LAN_FP = crypto.createHash('sha256').update(new crypto.X509Certificate(lanIdentity.cert).raw).digest('hex');
const LAN_FP_MAC = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update('supacode-lan-fp-v1:' + LAN_FP).digest('hex');
const lanWss = new WebSocketServer({ noServer: true });
let lanServer = null;

lanWss.on('connection', (ws) => {
  // LAN предлага само Office Mac.
  const c = {
    ws, attached: null, lan: true, hostId: officeHost.id, id: 'lan-' + Math.random().toString(16).slice(2, 8),
    sendText: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
  };
  clients.add(c);
  log('lan connect', c.id, ws._socket?.getProtocol?.() ?? '');
  ws.on('message', (data) => {
    const text = data.toString('utf8');
    if (text === 'ping') { ws.send('pong'); return; }
    let msg;
    try { msg = JSON.parse(text); } catch { log('bad json', text); return; }
    if (msg.t !== 'input' && msg.t !== 'list') log('<- lan', c.id, text.slice(0, 200));
    handle(c, msg);
  });
  ws.on('close', () => { clients.delete(c); log('lan close', c.id); });
});

function startLan() {
  lanServer = createHttpsServer({
    key: lanIdentity.private, cert: lanIdentity.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
  }, (req, res) => res.writeHead(404).end('not found'));
  lanServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'https://x').pathname !== '/lan') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      log('lan 401', req.socket.remoteAddress);
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    lanWss.handleUpgrade(req, socket, head, (ws) => lanWss.emit('connection', ws));
  });
  lanServer.listen(LAN_PORT, '127.0.0.1', () => log(`LAN endpoint on wss://127.0.0.1:${LAN_PORT}/lan  addrs=${LAN_ADDRS}  fp=${LAN_FP}`));
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
