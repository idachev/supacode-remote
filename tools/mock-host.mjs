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

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { homeRepos, officeRepos, rowIds, sections } from './mock-data.mjs';
import { addTabToPane, layoutMessage, splitPane, syncLayout } from './mock-layout.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.KEY ?? 'test-key';
const LAN_PORT = Number(process.env.LAN_PORT ?? 8788);
const LAN_ADDRS = (process.env.LAN_ADDRS ?? '10.0.2.2').split(',');
let lanOn = process.env.LAN !== '0';
const COLS = 120;
const ROWS = 40;
const SCREEN_BUFFER_BYTES = 64 * 1024;
/** Най-много толкова закачени таба на връзка (`attach` с `keep`); 16 като на Mac-а. */
const ATTACH_LIMIT = Number(process.env.MOCK_ATTACH_LIMIT ?? 16);
/** Какво знае host-ът отгоре на основните съобщения (`hello.caps`). */
const CAPS = ['attach.keep', 'watch', 'layout', 'tab.close', 'pane.split', 'pane.close', 'resize.hold'];
/** Колко дълго задържан размер остава без собственик след паднала връзка. */
const HOLD_GRACE_MS = Number(process.env.MOCK_HOLD_GRACE_MS ?? 30_000);
/** `watch`: най-много един `list` на толкова ms на връзка. */
const WATCH_INTERVAL_MS = 250;

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

/** Прост token се пише както е; друг текст — в единични кавички, с видими управляващи знаци. */
function logValue(value) {
  if (value === null || value === undefined || typeof value !== 'string') return String(value);
  if (/^[\w.:/@+-]+$/.test(value)) return value;
  const visible = JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"');
  return `'${visible.replace(/'/g, "''")}'`;
}

/** `ЧЧ:ММ:СС.ммм <фиксирано съобщение>, поле: стойност, …` — стойностите са само в полетата. */
function log(message, fields = {}) {
  const tail = Object.entries(fields).map(([k, v]) => `, ${k}: ${logValue(v)}`).join('');
  console.log(`${new Date().toISOString().slice(11, 23)} ${message}${tail}`);
}

const withSections = process.env.MOCK_NO_SECTIONS !== '1';
const oldRelay = process.env.MOCK_OLD_RELAY === '1';

/** Един Mac на mock relay-а. `lan` — само той предлага LAN; `rowIds`/`sections` — sidebar-ът му. */
function makeHost({ id, name, online, repos: hostRepos, lan = false, rowIds: hostRowIds, sections: hostSections }) {
  return {
    id, name, originalName: name, online, repos: hostRepos, sessions: new Map(), lan, layouts: new Map(),
    rowIds: hostRowIds, sections: hostSections,
    knownContent: new Set(hostRepos.flatMap((r) => r.worktrees.flatMap((w) => w.tabs.map((t) => t.contentId)))),
  };
}

/** hostId → Mac. Id-тата приличат на истинските (16 hex), за да се видят в лога. */
const hosts = new Map();
const singleHost = process.env.MOCK_SINGLE_HOST === '1';
const office = { id: '0f1ce0ff1ce0ff1c', online: true, repos: officeRepos, lan: true, rowIds, sections };
for (const h of singleHost ? [makeHost({ ...office, name: 'Mock Mac' })] : [
  makeHost({ ...office, name: 'Office Mac' }),
  makeHost({ id: '40be40be40be40be', name: 'Home Mac', online: true, repos: homeRepos }),
  makeHost({ id: '3a1a3a1a3a1a3a1a', name: 'Mac mini', online: false, repos: [] }),
]) hosts.set(h.id, h);
if (process.env.MOCK_LEGACY === '1') {
  // Стар Supacode: без име и без hostId, relay-ят го води `default`. Дълбоко копие: `tab.new`
  // добавя в масива с табове, а общ масив би показал новия таб и в „Home Mac“.
  const legacyRepos = structuredClone(homeRepos).map(({ canCreateWorktree, ...r }) => ({ ...r, id: 'legacy-' + r.id }));
  hosts.set('default', makeHost({ id: 'default', online: true, repos: legacyRepos }));
}
const officeHost = hosts.get('0f1ce0ff1ce0ff1c');

/**
 * ЗД13: какво може новият host — изтриване на всеки worktree освен основния и такива, които се
 * трият сега, „Опресни“ и repository-тата, които „не се четат“. Старият host (`default`) не праща нищо.
 */
/**
 * `busy` на всеки таб (КЛ13, 974aeeb1 във fork-а): затварянето би прекъснало програма. Mock-ът не
 * следи процесите в shell-а: зает е таб с агент или `working`, чист shell — не. Старият host го изпуска.
 */
function withBusyTabs(host, repo) {
  if (host.id === 'default') return repo;
  const busy = (tab) => tab.agents.length > 0 || tab.working === true;
  return { ...repo, worktrees: repo.worktrees.map((w) => ({ ...w, tabs: w.tabs.map((tab) => ({ ...tab, busy: busy(tab) })) })) };
}

function withDeleteFlags(host, repo) {
  if (host.id === 'default') return repo;
  const deletable = (w) => repo.canCreateWorktree === true && w.status !== 'main' && !host.deletingWorktrees?.has(w.id);
  return { ...repo, worktrees: repo.worktrees.map((w) => ({ ...w, canDeleteWorktree: deletable(w) })) };
}

/** Състоянието на split-овете на worktree-то, съгласувано с табовете му (или `null` без табове). */
function layoutOf(host, worktree) {
  const state = syncLayout(host.layouts.get(worktree.id), worktree.tabs);
  if (state) host.layouts.set(worktree.id, state);
  else host.layouts.delete(worktree.id);
  return state;
}

/** Всеки worktree с табове получава `layout`; старият host не знае за него. */
function withLayouts(host, repo) {
  if (host.id === 'default') return repo;
  return {
    ...repo,
    worktrees: repo.worktrees.map((w) => {
      const state = layoutOf(host, w);
      return state ? { ...w, layout: layoutMessage(state) } : w;
    }),
  };
}

function listMessage(host, id) {
  const extra = host.id === 'default' ? {} : {
    canRefreshWorktrees: true,
    ...(host.loadFailure ? { loadFailures: [host.loadFailure] } : {}),
  };
  const repos = host.repos.map((r) => withLayouts(host, withBusyTabs(host, withDeleteFlags(host, r))));
  if (!withSections || !host.sections) return { t: 'list', id, repos, ...extra };
  return { t: 'list', id, repos: repos.map((r) => ({ ...r, rowIds: host.rowIds[r.id] })), sections: host.sections, ...extra };
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

/** Клиентите, вързани към Mac-а и закачени за този таб. */
function attachedClients(host, contentId) {
  return [...clients].filter((c) => c.hostId === host.id && c.attachments.has(contentId));
}

/**
 * Сесиите са по Mac (`host.sessions`): contentId → { host, contentId, proc, cols, rows, screen,
 * screenBytes, line }. Сесията знае своя Mac и таб, за да ги ползват командите на реда.
 */
function session(host, contentId, cols = COLS, rows = ROWS) {
  let s = host.sessions.get(contentId);
  if (s) return s;
  // `mac` е размерът на pane-а на Mac-а: към него се връща таб, чието задържане свършва.
  s = {
    host, contentId, proc: spawnShell(cols, rows), cols, rows, screen: [], screenBytes: 0, line: '',
    mac: { cols: COLS, rows: ROWS }, hold: null,
  };
  host.sessions.set(contentId, s);
  s.proc.onData((buf) => onShellData(s, buf));
  s.proc.onExit((e) => onShellExit(s, e));
  return s;
}

function onShellData(s, buf) {
  s.screen.push(buf);
  s.screenBytes += buf.length;
  while (s.screenBytes > SCREEN_BUFFER_BYTES && s.screen.length > 1) s.screenBytes -= s.screen.shift().length;
  const out = { t: 'out', contentId: s.contentId, b64: buf.toString('base64') };
  attachedClients(s.host, s.contentId).forEach((c) => send(c, out));
}

function onShellExit(s, e) {
  log('shell ended', { host: s.host.id, content: s.contentId, exit_code: e?.exitCode ?? null });
  s.host.sessions.delete(s.contentId);
  endHold(s, { restore: false });
  // Mac-ът затваря таба, щом shell-ът му свърши (`exit`); `tab.close` вече го е махнал.
  for (const worktree of s.host.repos.flatMap((r) => r.worktrees)) {
    const tab = worktree.tabs.find((t) => t.contentId === s.contentId);
    if (tab) worktree.tabs.splice(worktree.tabs.indexOf(tab), 1);
  }
  s.host.knownContent.delete(s.contentId);
  for (const c of attachedClients(s.host, s.contentId)) {
    c.attachments.delete(s.contentId);
    send(c, { t: 'detached', contentId: s.contentId, reason: 'session ended' });
  }
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

function resizeSession(s, cols, rows) {
  if (cols !== s.cols || rows !== s.rows) s.proc.resize(cols, rows);
  s.cols = cols;
  s.rows = rows;
  attachedClients(s.host, s.contentId).forEach((c) => send(c, { t: 'size', contentId: s.contentId, cols, rows }));
}

/**
 * Спира shell-а на затворен таб. Задържането свършва веднага, а не чак с асинхронния изход на
 * shell-а: иначе таймерът му може да върне размера и да прати `size` за вече затворен таб.
 */
function stopSession(host, contentId) {
  const s = host.sessions.get(contentId);
  if (!s) return;
  endHold(s, { restore: false });
  s.proc.kill();
}

/** Mac-ът сам сменя pane-а си. Задържан размер не се мени: само се запомня новият размер на Mac-а. */
function resizeFromMac(s, cols, rows) {
  s.mac = { cols, rows };
  if (s.hold) {
    log('mac resize while held', { host: s.host.id, content: s.contentId, cols, rows });
    return;
  }
  resizeSession(s, cols, rows);
}

// ---- Задържан размер (`resize` с `hold:true`) ----

/**
 * Край на задържането. `restore` — без по-нов resize: размерът на Mac-а се връща и всички закачени
 * получават `size`. Без `restore` (по-нов resize, `resize_failed`, край на shell-а) — нищо не се мени.
 */
function endHold(s, { restore }) {
  if (!s.hold) return;
  clearTimeout(s.hold.graceTimer);
  s.hold = null;
  log('hold ended', { host: s.host.id, content: s.contentId, restore });
  if (restore && s.host.sessions.get(s.contentId) === s) resizeSession(s, s.mac.cols, s.mac.rows);
}

/** Задържанията на тази връзка по тези табове свършват веднага (`detach`, `attach` без `keep`). */
function releaseHolds(c, host, contentIds) {
  for (const contentId of contentIds) {
    const s = host.sessions.get(contentId);
    if (s?.hold?.owner === c) endHold(s, { restore: true });
  }
}

/** Връзката на собственика падна: задържането остава без собственик за `HOLD_GRACE_MS`. */
function orphanHolds(c) {
  for (const host of hosts.values()) {
    for (const s of host.sessions.values()) {
      if (s.hold?.owner !== c) continue;
      s.hold.owner = null;
      log('hold orphaned', { host: host.id, content: s.contentId, grace_ms: HOLD_GRACE_MS });
      s.hold.graceTimer = setTimeout(() => endHold(s, { restore: true }), HOLD_GRACE_MS);
    }
  }
}

/** Само таб с поне един агент в `list`, който не е read-only, получава Ctrl+L след задържан resize. */
function wantsCtrlL(host, contentId) {
  return host.repos.some((r) => r.worktrees.some((w) => w.tabs.some((t) => t.contentId === contentId && !t.readOnly && t.agents?.length > 0)));
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

function send(c, msg) {
  c.sendText(JSON.stringify(msg));
}

// ---- Съобщенията от клиента ----

function helloMessage(c, host) {
  return {
    // Стар Supacode (`default`) не знае своя hostId.
    t: 'hello', v: 1, host: host.name ?? 'Mac', ...(host.id === 'default' ? {} : { hostId: host.id, app: 'Supacode 0.0.0-mock (1)', caps: CAPS }),
    ...(host.lan && lanOn && !c.lan ? { lan: { addrs: LAN_ADDRS, port: LAN_PORT, fp: LAN_FP, fpMac: LAN_FP_MAC } } : {}),
  };
}

function attach(c, host, msg) {
  if (!host.knownContent.has(msg.contentId)) {
    send(c, { t: 'error', id: msg.id ?? null, message: `unknown content ${msg.contentId}` });
    return;
  }
  // Старият host не знае `keep`: всеки attach откача другите, както преди.
  const keep = msg.keep === true && host.id !== 'default';
  if (keep && !c.attachments.has(msg.contentId) && c.attachments.size >= ATTACH_LIMIT) {
    log('attach refused', { host: host.id, content: msg.contentId, client: c.id, attached: c.attachments.size });
    send(c, { t: 'error', id: msg.id ?? null, code: 'attach_limit', contentId: msg.contentId, message: 'too many attached terminals' });
    return;
  }
  const s = session(host, msg.contentId);
  if (!keep) {
    // Повторен attach на същия таб пази задържането му; другите табове на връзката се освобождават.
    releaseHolds(c, host, [...c.attachments].filter((id) => id !== msg.contentId));
    c.attachments.clear();
  }
  c.attachments.add(msg.contentId);
  send(c, { t: 'attached', id: msg.id, contentId: msg.contentId, cols: s.cols, rows: s.rows });
  // Първото `out` е „текущият екран“: тук — последните байтове на shell-а.
  send(c, { t: 'out', contentId: msg.contentId, b64: Buffer.concat(s.screen).toString('base64') });
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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * „Размер по този екран“ (ЗД12): само за закачен таб; host-ът ограничава и праща `size` на всички,
 * и когато размерът вече е такъв. Неуспех — `error` с `code:"resize_failed"` само на питащия; той
 * прекратява и задържането. С `hold:true` размерът получава собственик (тази връзка) и Ctrl+L, ако
 * табът има агент; без `hold` задържането свършва, без размерът да се връща.
 */
function resize(c, host, msg) {
  const s = host.sessions.get(msg.contentId);
  if (!s || !c.attachments.has(msg.contentId) || !Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) {
    log('resize ignored', { host: host.id, content: msg.contentId ?? null, client: c.id });
    return;
  }
  const held = msg.hold === true && host.id !== 'default';
  if (s.resizeFails) {
    log('resize failed', { host: host.id, content: msg.contentId, client: c.id });
    endHold(s, { restore: false });
    send(c, { t: 'error', id: msg.id ?? null, message: 'terminal did not start', code: 'resize_failed', contentId: msg.contentId });
    return;
  }
  const cols = clamp(msg.cols, 20, 500);
  const rows = clamp(msg.rows, 5, 200);
  if (held) {
    clearTimeout(s.hold?.graceTimer);
    s.hold = { owner: c, graceTimer: null };
  } else {
    endHold(s, { restore: false });
  }
  log('resize applied', { host: host.id, content: msg.contentId, client: c.id, hold: held, cols, rows });
  resizeSession(s, cols, rows);
  if (held && wantsCtrlL(host, msg.contentId)) {
    s.proc.write(Buffer.from([0x0c]));
    log('ctrl-l sent', { content: msg.contentId });
  }
}

let newTabCounter = 0;

/** Нов shell-таб в worktree-то: добавя го в списъка и пуска сесията му. */
function createTab(host, worktree, { cols = COLS, rows = ROWS, focused = false } = {}) {
  newTabCounter += 1;
  const contentId = `content-new-${newTabCounter}`;
  const tabId = `tab-new-${newTabCounter}`;
  worktree.tabs.push({ id: tabId, contentId, title: 'zsh', focused, working: false, readOnly: false, agents: [] });
  host.knownContent.add(contentId);
  session(host, contentId, cols, rows);
  return { tabId, contentId };
}

/**
 * Нов таб: размерът от заявката (ЗД12), ако е даден и в двете посоки, иначе 120 × 40. С `paneId`
 * от `layout` табът отива в този pane; непознат `paneId` се пренебрегва (не-низ спира още
 * `handle`).
 */
function newTab(c, host, msg) {
  const worktree = host.repos.flatMap((r) => r.worktrees).find((w) => w.id === msg.worktreeId);
  if (!worktree) {
    send(c, { t: 'error', id: msg.id ?? null, message: `unknown worktree ${msg.worktreeId}` });
    return;
  }
  const sized = Number.isInteger(msg.cols) && Number.isInteger(msg.rows);
  const cols = sized ? clamp(msg.cols, 20, 500) : COLS;
  const rows = sized ? clamp(msg.rows, 5, 200) : ROWS;
  const { tabId, contentId } = createTab(host, worktree, { cols, rows });
  const state = host.id === 'default' ? null : layoutOf(host, worktree);
  if (state && state.panes.some((p) => p.id === msg.paneId)) addTabToPane(state, msg.paneId, tabId);
  // Размерът остава в края на реда: e2e тестът на страницата го чете оттам.
  log('tab opened', { host: host.id, worktree: msg.worktreeId, ...(msg.paneId ? { pane: msg.paneId } : {}), content: contentId, cols, rows });
  send(c, { t: 'tab.new', id: msg.id, worktreeId: msg.worktreeId, tabId, contentId });
}

/** Таб по id в worktree-тата на Mac-а: `{ worktree, tab }` или `null`. */
function findTab(host, tabId) {
  for (const worktree of host.repos.flatMap((r) => r.worktrees)) {
    const tab = worktree.tabs.find((t) => t.id === tabId);
    if (tab) return { worktree, tab };
  }
  return null;
}

/** Pane по id: `{ worktree, state }` или `null`. */
function findPane(host, paneId) {
  for (const worktree of host.repos.flatMap((r) => r.worktrees)) {
    const state = layoutOf(host, worktree);
    if (state?.panes.some((p) => p.id === paneId)) return { worktree, state };
  }
  return null;
}

/** Затваря таба като бутона на Mac-а: маха го и спира shell-а (закачените получават `detached`). */
function closeTab(host, worktree, tab) {
  worktree.tabs.splice(worktree.tabs.indexOf(tab), 1);
  host.knownContent.delete(tab.contentId);
  stopSession(host, tab.contentId);
  log('tab closed', { host: host.id, worktree: worktree.id, content: tab.contentId });
}

/** Грешка на layout действие: винаги с `id` и `code` (раздел „tab.close“ в протокола). */
function layoutError(c, msg, code, message) {
  log(`${msg.t} failed`, { code, client: c.id });
  send(c, { t: 'error', id: msg.id ?? null, message, code });
}

function tabClose(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  if (typeof msg.tabId !== 'string' || !msg.tabId) return layoutError(c, msg, 'tab_invalid', 'tab.close needs a tabId');
  const found = findTab(host, msg.tabId);
  if (!found) return layoutError(c, msg, 'tab_invalid', 'no such tab');
  closeTab(host, found.worktree, found.tab);
  return send(c, { t: 'tab.close', id: msg.id ?? null, tabId: msg.tabId, worktreeId: found.worktree.id });
}

function paneSplit(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  if (typeof msg.paneId !== 'string' || !msg.paneId) return layoutError(c, msg, 'pane_invalid', 'pane.split needs a paneId');
  const found = findPane(host, msg.paneId);
  if (!found) return layoutError(c, msg, 'pane_invalid', 'no such pane');
  if (msg.direction !== 'horizontal' && msg.direction !== 'vertical') {
    return layoutError(c, msg, 'pane_invalid', 'direction must be horizontal or vertical');
  }
  const { tabId, contentId } = createTab(host, found.worktree);
  const paneId = splitPane(found.state, msg.paneId, msg.direction, tabId);
  log('pane split', { host: host.id, worktree: found.worktree.id, pane: paneId, content: contentId, direction: msg.direction });
  return send(c, { t: 'pane.split', id: msg.id ?? null, worktreeId: found.worktree.id, paneId, tabId, contentId });
}

function paneClose(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  if (typeof msg.paneId !== 'string' || !msg.paneId) return layoutError(c, msg, 'pane_invalid', 'pane.close needs a paneId');
  const found = findPane(host, msg.paneId);
  if (!found) return layoutError(c, msg, 'pane_invalid', 'no such pane');
  const pane = found.state.panes.find((p) => p.id === msg.paneId);
  for (const tabId of [...pane.tabIds]) {
    const tab = found.worktree.tabs.find((t) => t.id === tabId);
    if (tab) closeTab(host, found.worktree, tab);
  }
  layoutOf(host, found.worktree);
  return send(c, { t: 'pane.close', id: msg.id ?? null, paneId: msg.paneId, worktreeId: found.worktree.id });
}

// ---- watch ----

/** Ключът на снимката: `list` без `id`, за да се види дали има промяна. */
const snapshotKey = (list) => JSON.stringify({ ...list, id: null });

/** `list` към клиента; запомня снимката, с която `watch` сравнява. */
function sendList(c, host, id) {
  const list = listMessage(host, id);
  c.lastListKey = snapshotKey(list);
  send(c, list);
}

let watchTimer = null;

/**
 * Проверка на 250 ms, само докато някой гледа (host-ът не работи нищо без watch): при разлика от
 * последния изпратен `list` — нов `list` с `id:null`. Така и последното състояние винаги стига.
 */
function watchTick() {
  const watchers = [...clients].filter((c) => c.watching);
  if (watchers.length === 0) {
    clearInterval(watchTimer);
    watchTimer = null;
    return;
  }
  for (const c of watchers) {
    const host = hosts.get(c.hostId);
    if (!host || (!host.online && !c.lan)) continue;
    if (snapshotKey(listMessage(host, null)) !== c.lastListKey) sendList(c, host, null);
  }
}

function watch(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  // `on` е незадължително: без него `watch` пуска гледането (протоколът, „watch“).
  c.watching = msg.on !== false;
  log('watch', { host: host.id, client: c.id, on: c.watching });
  send(c, { t: 'watch', id: msg.id ?? null, on: c.watching });
  if (c.watching && !watchTimer) watchTimer = setInterval(watchTick, WATCH_INTERVAL_MS);
  return undefined;
}

/** Заявките `worktree.new`, които още чакат: repository + име с малки букви (`worktree_busy`). */
const creatingWorktrees = new Set();

function worktreeError(c, msg, code, message) {
  log('worktree.new failed', { code, client: c.id });
  send(c, { t: 'error', id: msg.id ?? null, message, code });
}

/** Проверките, които Mac-ът прави, преди да пусне git. `null` — може. */
function worktreeRequestError(host, msg) {
  if (typeof msg.repositoryId !== 'string') return ['worktree_invalid', 'worktree.new needs a repositoryId'];
  const repo = host.repos.find((r) => r.id === msg.repositoryId);
  if (!repo) return ['worktree_invalid', 'no such repository'];
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  if (!name) return ['worktree_invalid', 'worktree.new needs a branch name'];
  if (Buffer.byteLength(name) > 200) return ['worktree_invalid', 'the branch name is too long'];
  if (repo.canCreateWorktree !== true) return ['worktree_unsupported', 'worktrees are only supported for git repositories'];
  return null;
}

/** Нов worktree като бутона на Supacode: името е branch-ът, а първият таб се отваря сам. */
function newWorktree(c, host, msg) {
  // Стар Supacode (MOCK_LEGACY) не познава съобщението — точно като истинския router.
  if (host.id === 'default') return send(c, { t: 'error', id: msg.id ?? null, message: 'unknown message type: worktree.new' });
  const problem = worktreeRequestError(host, msg);
  if (problem) return worktreeError(c, msg, ...problem);
  const repo = host.repos.find((r) => r.id === msg.repositoryId);
  const name = msg.name.trim();
  const key = `${host.id}/${repo.id}/${name.toLowerCase()}`;
  if (creatingWorktrees.has(key)) return worktreeError(c, msg, 'worktree_busy', 'a worktree with this branch is already being created');
  creatingWorktrees.add(key);
  const delay = name.startsWith('mock-slow') ? 6_000 : name.startsWith('mock-timeout') ? 3_000 : 1_000;
  log('worktree.new started', { host: host.id, repo: repo.id, name, client: c.id });
  setTimeout(() => {
    creatingWorktrees.delete(key);
    finishWorktree(c, host, repo, name, msg);
  }, delay);
}

function finishWorktree(c, host, repo, name, msg) {
  const lower = name.toLowerCase();
  if (repo.worktrees.some((w) => w.name.toLowerCase() === lower || w.branch?.toLowerCase() === lower)) {
    return worktreeError(c, msg, 'worktree_failed', 'Branch name already exists: Choose a different branch name and try again.');
  }
  if (name.startsWith('mock-fail')) return worktreeError(c, msg, 'worktree_failed', 'Unable to create worktree: fatal: mock git failure');
  if (name.startsWith('mock-timeout')) {
    return worktreeError(c, msg, 'worktree_timeout', 'worktree creation is still running on the Mac; it will appear in the list when it finishes');
  }
  const worktree = { id: `/mock/${repo.name}/${name}`, name, branch: name, status: 'unpinned', focused: true, working: false, tabs: [] };
  repo.worktrees.push(worktree);
  // Иначе списъкът по секции не го показва: под repository-то стоят само id-тата от `rowIds`.
  if (host.rowIds?.[repo.id]) host.rowIds[repo.id].push(worktree.id);
  const reply = { t: 'worktree.new', id: msg.id ?? null, repositoryId: repo.id, worktreeId: worktree.id, name };
  if (!name.startsWith('mock-notab')) {
    const sized = Number.isInteger(msg.cols) && Number.isInteger(msg.rows);
    const size = sized ? { cols: clamp(msg.cols, 20, 500), rows: clamp(msg.rows, 5, 200) } : {};
    Object.assign(reply, createTab(host, worktree, { ...size, focused: true }));
  }
  log('worktree.new created', { host: host.id, repo: repo.id, name, content: reply.contentId ?? null, client: c.id });
  send(c, reply);
}

const UNKNOWN_TYPE = (c, msg) => send(c, { t: 'error', id: msg.id ?? null, message: `unknown message type: ${msg.t}` });

/** Проверките преди изтриване (ЗД13): `[code, message]` или `null`. */
function deleteRequestError(host, msg) {
  if (typeof msg.worktreeId !== 'string' || !msg.worktreeId) return ['worktree_invalid', 'worktree.delete needs a worktreeId'];
  const repo = host.repos.find((r) => r.worktrees.some((w) => w.id === msg.worktreeId));
  if (!repo) return ['worktree_invalid', 'no such worktree'];
  const worktree = repo.worktrees.find((w) => w.id === msg.worktreeId);
  if (worktree.status === 'main') return ['worktree_unsupported', 'the main worktree cannot be deleted'];
  if (repo.canCreateWorktree !== true) return ['worktree_unsupported', 'folders cannot be deleted from the remote'];
  if (host.deletingWorktrees?.has(worktree.id)) return ['worktree_busy', 'the worktree is busy (being created, archived or deleted)'];
  if (worktree.name.includes('dirty')) {
    return ['worktree_dirty', 'the worktree has uncommitted changes or untracked files (2): notes.txt, src/app.js; commit, stash or remove them on the Mac first'];
  }
  return null;
}

/**
 * Изтрива worktree като Mac-а, без branch-а: след 1 s (`mock-slow…` — 6 s) го маха от списъка,
 * от `rowIds` и от секциите, а shell-овете на табовете му свършват (`detached` към закачените).
 * Име с `dirty` дава `worktree_dirty`; `mock-fail…` — `worktree_failed`.
 */
function deleteWorktree(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  const problem = deleteRequestError(host, msg);
  if (problem) return worktreeError(c, msg, ...problem);
  const repo = host.repos.find((r) => r.worktrees.some((w) => w.id === msg.worktreeId));
  const worktree = repo.worktrees.find((w) => w.id === msg.worktreeId);
  host.deletingWorktrees ??= new Set();
  host.deletingWorktrees.add(worktree.id);
  log('worktree.delete started', { host: host.id, worktree: worktree.id, client: c.id });
  setTimeout(() => {
    host.deletingWorktrees.delete(worktree.id);
    if (worktree.name.startsWith('mock-fail')) {
      return worktreeError(c, msg, 'worktree_failed', 'Unable to delete worktree: fatal: mock git failure');
    }
    repo.worktrees.splice(repo.worktrees.indexOf(worktree), 1);
    for (const ids of Object.values(host.rowIds ?? {})) if (ids.includes(worktree.id)) ids.splice(ids.indexOf(worktree.id), 1);
    for (const section of host.sections ?? []) {
      if (section.worktreeIds?.includes(worktree.id)) section.worktreeIds.splice(section.worktreeIds.indexOf(worktree.id), 1);
    }
    for (const tab of worktree.tabs) stopSession(host, tab.contentId);
    log('worktree.delete done', { host: host.id, worktree: worktree.id, client: c.id });
    send(c, { t: 'worktree.delete', id: msg.id ?? null, worktreeId: worktree.id, repositoryId: repo.id });
  }, worktree.name.startsWith('mock-slow') ? 6_000 : 1_000);
}

/** Mac-ът чете worktree-тата наново: след 0,5 s пълен `list` със същото id (`mock-refresh-timeout` — грешка). */
function refreshWorktrees(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  setTimeout(() => {
    if (host.refreshTimeout) {
      return worktreeError(c, msg, 'refresh_timeout', 'the refresh is still running on the Mac; send list again later');
    }
    log('worktrees.refresh done', { host: host.id, client: c.id });
    sendList(c, host, msg.id ?? null);
  }, 500);
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
  detach: (c, host, msg) => {
    releaseHolds(c, host, [msg.contentId]);
    c.attachments.delete(msg.contentId);
  },
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

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found' };

function rejectUpgrade(socket, status, body = '') {
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function authorized(req, endpoint) {
  if (req.headers.authorization === `Bearer ${KEY}`) return true;
  log('upgrade rejected', { endpoint, status: 401, remote: req.socket.remoteAddress });
  return false;
}

/**
 * Към кой Mac е вързан клиентът: `?host=`, или `undefined` за невалиден id. Както relay-ят:
 * проверка след ключа, преди upgrade-а (РЛ6); непознат, но валиден id се връзва (офлайн).
 * Стар relay не знае `host`: всички са при единствения Mac.
 */
function boundHost(url) {
  const hostId = url.searchParams.get('host');
  if (hostId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) return undefined;
  return oldRelay ? officeHost.id : hostId;
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

// LAN предлага само Office Mac.
lanWss.on('connection', (ws) => acceptClient(ws, { endpoint: 'lan', hostId: officeHost.id, lan: true }));

function startLan() {
  lanServer = createHttpsServer({
    key: lanIdentity.private, cert: lanIdentity.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
  }, (req, res) => res.writeHead(404).end('not found'));
  lanServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'https://x').pathname !== '/lan') return rejectUpgrade(socket, 404);
    if (!authorized(req, 'lan')) return rejectUpgrade(socket, 401);
    lanWss.handleUpgrade(req, socket, head, (ws) => lanWss.emit('connection', ws));
  });
  lanServer.listen(LAN_PORT, '127.0.0.1', () => log('lan endpoint listening', {
    url: `wss://127.0.0.1:${LAN_PORT}/lan`, addrs: LAN_ADDRS.join(','), fp: LAN_FP,
  }));
}

function setLan(on) {
  if (on === lanOn) return;
  lanOn = on;
  log('lan endpoint switched', { on });
  if (on) {
    startLan();
  } else {
    for (const c of clients) if (c.lan) c.ws.terminate();
    lanServer?.close();
    lanServer = null;
  }
}

if (lanOn) startLan();

server.listen(PORT, '127.0.0.1', () => log('mock host listening', {
  url: `http://127.0.0.1:${PORT}`, pty: pty ? 'node-pty' : 'script', emulator_key: `http://10.0.2.2:${PORT}/${KEY}`,
}));
