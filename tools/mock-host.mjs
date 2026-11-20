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
//           MOCK_LEGACY=1 за още един онлайн Mac `default` без име — стар Supacode,
//           MOCK_SINGLE_HOST=1 за един Mac „Mock Mac“ с repo-тата и LAN-а на Office Mac —
//           тестовете на web/ тръгват направо към списъка,
//           MOCK_ATTACH_LIMIT=<N> за друг таван на attach-овете с `keep` (16 като на Mac-а) —
//           тестовете стигат `attach_limit` с няколко таба)
//
// Няколко Mac-а (раздел „Multiple hosts“ в протокола): „Office Mac“ (repo-тата по-долу и LAN),
// „Home Mac“ (свои repo-та и contentId-та) и „Mac mini“ (извън линия). `/client?host=<id>`
// връзва връзката към този Mac; без `host` тя е несвързана — получава само списъка, а всяка
// заявка — `host offline`.
// Ключът за връзка от emulator-а: http://10.0.2.2:8787/test-key
//
// Специални редове, написани в кой да е таб (за ръчна проба):
//   mock-resize   — host-ът сменя размера на 100x30 и праща `size`;
//   mock-resize-fail / mock-resize-ok — следващите `resize` на този таб връщат `error` с
//                   `code:"resize_failed"` / пак минават;
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
// `resize` (ЗД12) сменя размера на таба, към който връзката е закачена (20…500 × 5…200), и праща
// `size` на всички закачени към него; без промяна `size` няма, а за чужд таб се пренебрегва.
//
// `tab.new` отваря нов shell в worktree-то на свързания Mac. С `cols` и `rows` (и двете, цели
// числа) той тръгва с този размер, ограничен до 20…500 × 5…200; без тях — 120 × 40, както на Mac-а.
//
// `worktree.new` (ЗД11) създава worktree с първи таб в repository-то, след 1 s. Грешките са като на
// Mac-а: `worktree_invalid` (няма repository / име, име над 200 байта), `worktree_unsupported`
// (notes-app е папка), `worktree_busy` (същото име още се създава), `worktree_failed` (име, което
// вече има). Имената пробват другите случаи: `mock-fail…` — грешка от git, `mock-slow…` — 6 s,
// `mock-timeout…` — `worktree_timeout` след 3 s, `mock-notab…` — успех без таб. Старият host
// (MOCK_LEGACY) не праща `canCreateWorktree` и отговаря на `worktree.new` с „unknown type“.
//
// `worktree.delete` и `worktrees.refresh` (ЗД13): изтриване без branch-а след 1 s; име с `dirty` —
// `worktree_dirty`, `mock-slow…` — 6 s, `mock-fail…` — `worktree_failed`; основният не се трие.
// „Опресни“ връща `list` със същото id след 0,5 s. В таб: `mock-loadfail` пуска/спира едно
// repository в `loadFailures`, `mock-refresh-timeout` — `refresh_timeout` на „Опресни“.
//
// Отдалеченият клиент в Supacode (branch `remote-client-host` на fork-а): `hello` има `caps`. `attach` с `keep:true` държи до 16 таба на връзка (17-ият —
// `attach_limit`), `detach` спира само своя, `resize` важи за всеки закачен. Всеки worktree с табове
// има `layout` (минимален модел: `mock-layout.mjs`). `watch` праща `list` с `id:null` при промяна,
// най-много веднъж на 250 ms (заглавията в mock-а не се менят, затова правилото за 2 s не е нужно).
// `tab.close`, `pane.split`, `pane.close` и `tab.new` с `paneId`; грешки `tab_invalid`, `pane_invalid`.
// `resize` с `hold:true` задържа размера за връзката, поискала последна: Ctrl+L след него само за
// таб с агент; обикновен `resize` го прекратява; `detach` на собственика или негов `attach` на друг
// таб без `keep` го освобождава; паднала връзка го държи 30 s без собственик (MOCK_HOLD_GRACE_MS),
// а `resize` с `hold` в това време го поема. При край без по-нов resize размерът се връща към
// „pane-а на Mac-а“ (120 × 40, или 100 × 30 след `mock-resize`) и всички закачени получават `size`.
// `mock-resize` по време на задържане сменя само размера на Mac-а, не PTY-то.
// `exit` в shell-а затваря таба, както на Mac-а. Строго поле от грешен тип (`keep`, `on`, `hold`,
// `tabId`, `paneId`) спира кадъра без отговор. Всеки таб носи `busy`: зает е таб с агент или
// `working`, чист shell — не (mock-ът не следи процесите в shell-а).
// Старият host (MOCK_LEGACY) не знае нищо от това.
//
// LAN пътят (раздел „LAN shortcut“ в протокола): wss://127.0.0.1:LAN_PORT/lan (8788), от
// emulator-а 10.0.2.2. TLS 1.3 със самоподписан сертификат от паметта, `fp` и `fpMac` в
// `hello`. LAN=0 го изключва.
//
// Модулите: mock-config (средата), mock-hosts (Mac-овете), mock-clients (връзките), mock-sessions
// (shell-овете, attach и resize), mock-list (`list` и `watch`), mock-tabs (табове и pane-ове),
// mock-worktrees (worktree.*), mock-lan (LAN endpoint-ът). Тук са само `relay`, `hello`, редовете
// в таб и разпределянето на съобщенията.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { authorized, clients, rejectUpgrade, send } from './mock-clients.mjs';
import { KEY, OLD_RELAY, PORT } from './mock-config.mjs';
import { hostList, hosts, officeHost } from './mock-hosts.mjs';
import { lanOffer, lanWss, setLan, startLanAtBoot } from './mock-lan.mjs';
import { sendList, watch } from './mock-list.mjs';
import { log } from './mock-log.mjs';
import { attach, detach, orphanHolds, resize, resizeFromMac } from './mock-sessions.mjs';
import { shellKind } from './mock-shell.mjs';
import { newTab, paneClose, paneSplit, tabClose } from './mock-tabs.mjs';
import { deleteWorktree, newWorktree, refreshWorktrees } from './mock-worktrees.mjs';

/** Какво знае host-ът отгоре на основните съобщения (`hello.caps`). */
const CAPS = ['attach.keep', 'watch', 'layout', 'tab.close', 'pane.split', 'pane.close', 'resize.hold'];

/** `relay` за един клиент: своят `host` и `hostOnline`, общ списък. */
function relayMessage(c) {
  const host = hosts.get(c.hostId);
  const hostOnline = Boolean(host?.online);
  if (OLD_RELAY) return { t: 'relay', hostOnline };
  return { t: 'relay', hostOnline, ...(c.hostId ? { host: c.hostId } : {}), hosts: hostList() };
}

function broadcastRelay() {
  for (const c of clients) if (!c.lan) send(c, relayMessage(c));
}

/** Специалните редове от горния коментар, по края на реда. */
const lineCommands = {
  'mock-resize': (s) => resizeFromMac(s, 100, 30),
  'mock-resize-fail': (s) => { s.resizeFails = true; },
  'mock-resize-ok': (s) => { s.resizeFails = false; },
  'mock-await': (s) => setActivity(s.host, s.contentId, 'awaitingInput'),
  'mock-busy': (s) => setActivity(s.host, s.contentId, 'busy'),
  'mock-rename': (s) => toggleHostName(s.host),
  'mock-other-off': (s) => setOtherHostOnline(s.host, false),
  'mock-other-on': (s) => setOtherHostOnline(s.host, true),
  'mock-loadfail': (s) => {
    s.host.loadFailure = s.host.loadFailure ? null : { repositoryId: '/mock/broken-repo', message: 'fatal: not a git repository' };
    log('mock load failure', { host: s.host.id, on: s.host.loadFailure != null });
  },
  'mock-refresh-timeout': (s) => {
    s.host.refreshTimeout = !s.host.refreshTimeout;
    log('mock refresh timeout', { host: s.host.id, on: s.host.refreshTimeout });
  },
  'mock-lan-off': () => setLan(false),
  'mock-lan-on': () => setLan(true),
  'mock-offline': (s) => {
    setHostOnline(s.host, false);
    setTimeout(() => setHostOnline(s.host, true), 5000);
  },
};

/** Гледа се само какво е написано преди Enter: командата е в края на реда. */
function watchLine(s, text) {
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') endLine(s);
    else s.line = ch === '\u007f' ? s.line.slice(0, -1) : s.line + ch;
  }
}

function endLine(s) {
  const line = s.line.trim();
  s.line = '';
  const command = Object.keys(lineCommands).find((name) => line.endsWith(name));
  if (command) lineCommands[command](s);
}

/** Преименуване без нова връзка: relay-ят само праща новия списък. */
function toggleHostName(host) {
  host.name = host.name === host.originalName ? `${host.originalName} (нов)` : host.originalName;
  log('host renamed', { host: host.id, name: host.name });
  broadcastRelay();
}

/** Другият Mac с repo-та (не стария `default`): за ръба на list-only `relay`. */
function setOtherHostOnline(host, online) {
  const other = [...hosts.values()].find((h) => h !== host && h.repos.length > 0 && h.id !== 'default');
  if (other) setHostOnline(other, online);
}

/** Агентът на таба минава в това състояние; таб без агент получава `claude`. */
function setActivity(host, contentId, activity) {
  const tabs = host.repos.flatMap((r) => r.worktrees.flatMap((w) => w.tabs)).filter((t) => t.contentId === contentId);
  for (const tab of tabs) {
    if (tab.agents.length === 0) tab.agents.push({ agent: 'claude', activity });
    tab.agents.forEach((a) => { a.activity = activity; });
    log('agent activity changed', { host: host.id, content: contentId, activity });
  }
}

function setHostOnline(host, online) {
  host.online = online;
  log('host online changed', { host: host.id, online });
  // Host-ът си е отишъл — потоците му са спрели. LAN не минава през relay-а.
  // Върнатият Mac вижда нова връзка: и `watch` трябва да се прати наново.
  if (!online) {
    [...clients].filter((c) => !c.lan && c.hostId === host.id).forEach((c) => {
      orphanHolds(c);
      c.attachments.clear();
      c.watching = false;
      c.lastListKey = null;
    });
  }
  // Вързаните към него виждат ръба, другите — само новия списък.
  broadcastRelay();
}

// ---- Съобщенията от клиента ----

function helloMessage(c, host) {
  const lan = lanOffer();
  return {
    // Стар Supacode (`default`) не знае своя hostId.
    t: 'hello', v: 1, host: host.name ?? 'Mac', ...(host.id === 'default' ? {} : { hostId: host.id, app: 'Supacode 0.0.0-mock (1)', caps: CAPS }),
    ...(host.lan && lan && !c.lan ? { lan } : {}),
  };
}

function input(c, host, msg) {
  const s = host.sessions.get(msg.contentId);
  if (!s || !c.attachments.has(msg.contentId)) {
    send(c, { t: 'error', id: null, message: 'not attached' });
    return;
  }
  const bytes = Buffer.from(msg.b64, 'base64');
  const text = bytes.toString('utf8');
  log('input received', { host: host.id, content: msg.contentId, text, hex: bytes.toString('hex') });
  s.proc.write(bytes);
  watchLine(s, text);
}

function suggest(c, msg) {
  const suggestions = ['git status', 'echo здравей 👋', 'ls -la'];
  setTimeout(() => send(c, { t: 'suggest', id: msg.id, contentId: msg.contentId, suggestions }), 2000);
}

const messageHandlers = {
  hello: (c, host) => send(c, helloMessage(c, host)),
  // Новият host отговаря с `id:null` на `list` без `id`; старият го изпуска.
  list: (c, host, msg) => sendList(c, host, host.id === 'default' ? msg.id : (msg.id ?? null)),
  attach,
  detach,
  input,
  resize,
  'tab.new': newTab,
  'worktree.new': newWorktree,
  'worktree.delete': deleteWorktree,
  'worktrees.refresh': refreshWorktrees,
  suggest: (c, host, msg) => suggest(c, msg),
  watch,
  'tab.close': tabClose,
  'pane.split': paneSplit,
  'pane.close': paneClose,
};

/** Строгите полета на layout съобщенията и типът им (правилото на decoder-а в протокола). */
const STRICT_FIELDS = { keep: 'boolean', on: 'boolean', hold: 'boolean', tabId: 'string', paneId: 'string' };

const badStrictField = (msg) => Object.keys(STRICT_FIELDS).find((k) => msg[k] !== undefined && typeof msg[k] !== STRICT_FIELDS[k]);

function handle(c, msg) {
  const host = hosts.get(c.hostId);
  if (!host || (!host.online && !c.lan)) {
    send(c, { t: 'error', id: msg.id ?? null, message: 'host offline' });
    return;
  }
  // Кадър със строго поле от грешен тип се пропуска без отговор, в каквото и да е съобщение.
  // Старият host не знае тези полета и ги пренебрегва.
  const bad = host.id === 'default' ? undefined : badStrictField(msg);
  if (bad) {
    log('frame dropped', { host: host.id, type: msg.t, field: bad, client: c.id });
    return;
  }
  const handler = messageHandlers[msg.t];
  if (handler) handler(c, host, msg);
  else send(c, { t: 'error', id: msg.id ?? null, message: `unknown type ${msg.t}` });
}

// ---- HTTP + WebSocket ----

const server = createServer((req, res) => {
  res.writeHead(404).end('not found');
});
const wss = new WebSocketServer({ noServer: true });

/**
 * Към кой Mac е вързан клиентът: `?host=`, или `undefined` за невалиден id. Както relay-ят:
 * проверка след ключа, преди upgrade-а (РЛ6); непознат, но валиден id се връзва (офлайн).
 * Стар relay не знае `host`: всички са при единствения Mac.
 */
function boundHost(url) {
  const hostId = url.searchParams.get('host');
  if (hostId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) return undefined;
  return OLD_RELAY ? officeHost.id : hostId;
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/client') return rejectUpgrade(socket, 404);
  if (!authorized(req, 'client')) return rejectUpgrade(socket, 401);
  const hostId = boundHost(url);
  if (hostId === undefined) return rejectUpgrade(socket, 400, 'bad host id');
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, hostId));
});

/** Нов клиент по relay-а или по LAN: същите съобщения, различен само произходът. */
function acceptClient(ws, { endpoint, hostId, lan }) {
  const c = {
    ws, attachments: new Set(), watching: false, lastListKey: null, lan, hostId, id: Math.random().toString(16).slice(2, 10),
    sendText: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
  };
  clients.add(c);
  log('client connected', { endpoint, host: hostId ?? null, client: c.id });
  if (!lan) send(c, relayMessage(c));
  ws.on('message', (data) => onClientText(c, endpoint, data.toString('utf8')));
  ws.on('close', () => {
    clients.delete(c);
    orphanHolds(c);
    log('client closed', { endpoint, host: hostId ?? null, client: c.id });
  });
}

function onClientText(c, endpoint, text) {
  if (text === 'ping') return c.ws.send('pong');
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    log('bad json', { endpoint, client: c.id, text });
    return;
  }
  // `input` има свой ред с hex, а `list` идва на 3 s и само би шумял.
  if (msg.t !== 'input' && msg.t !== 'list') log('message received', { endpoint, type: msg.t, client: c.id, text });
  handle(c, msg);
}

wss.on('connection', (ws, hostId) => acceptClient(ws, { endpoint: 'client', hostId, lan: false }));

// LAN предлага само Office Mac.
lanWss.on('connection', (ws) => acceptClient(ws, { endpoint: 'lan', hostId: officeHost.id, lan: true }));

startLanAtBoot();

server.listen(PORT, '127.0.0.1', () => log('mock host listening', {
  url: `http://127.0.0.1:${PORT}`, pty: shellKind(), emulator_key: `http://10.0.2.2:${PORT}/${KEY}`,
}));
