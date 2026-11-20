// Протоколът v1 от docs/remote-access-protocol.md в repo-то на Supacode, откъм клиента.
// Пренесен от Android (`protocol/Protocol.kt`, `protocol/RelayUrl.kt`), за да говори
// уеб app-ът със същия relay и същия Mac по същия начин.

export const PROTOCOL_VERSION = 1;
export const ATTACH_SCROLLBACK = 500;

/**
 * Стойностите в `hello.caps`, които клиентът ползва. Host без `caps` (стар Mac) не знае нито
 * една от тях, затова всяка се проверява по сокета, преди съобщението да тръгне (ДЗ1, ДЗ8b).
 */
export const CAPS = Object.freeze({ WATCH: 'watch', ATTACH_KEEP: 'attach.keep' });

/** Кодът на грешката за 17-ия `attach` на една връзка (таванът на Mac-а е 16). */
export const ATTACH_LIMIT = 'attach_limit';

/** Keepalive-ът е голият текст, не JSON. */
export const PING = 'ping';
export const PONG = 'pong';

const SCHEMES = { https: 'wss', http: 'ws', wss: 'wss', ws: 'ws' };
const DEFAULT_SCHEME = 'https://';

/**
 * `https://…` → `wss://…/client`, `http://…` → `ws://…/client`. `null` за празен адрес или
 * непозната схема, за да покаже „Настройка“ грешката веднага. С [hostId] — `?host=<id>`
 * (multi-host: сокетът се връзва към този Mac за целия си живот).
 */
export function clientUrl(base, hostId = null) {
  const trimmed = String(base ?? '').trim().replace(/\/+$/, '');
  const sep = trimmed.indexOf('://');
  if (sep <= 0) return null;
  const scheme = SCHEMES[trimmed.slice(0, sep).toLowerCase()];
  if (!scheme) return null;
  const rest = trimmed.slice(sep + 3);
  if (rest === '' || rest.startsWith('/')) return null;
  const withoutClient = rest.endsWith('/client') ? rest.slice(0, -'/client'.length) : rest;
  const url = `${scheme}://${withoutClient}/client`;
  // Грешен порт или хост (`example.com:bad`) иначе минава тук и пада чак при свързване.
  try {
    new URL(url);
  } catch {
    return null;
  }
  return hostId ? `${url}?host=${encodeURIComponent(hostId)}` : url;
}

/**
 * Ключът за връзка `<relay>/<клиентски ключ>`: ключът е след **последната** `/`. Без схема
 * relay-ят е `https://`; локален тестов relay носи своята. `null`, ако част липсва.
 */
export function parseConnectionKey(text) {
  const trimmed = String(text ?? '').trim();
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return null;
  const apiKey = trimmed.slice(slash + 1).trim();
  const relay = trimmed.slice(0, slash).trim().replace(/\/+$/, '');
  if (!apiKey || !relay || relay.endsWith(':')) return null;
  const baseUrl = relay.includes('://') ? relay : DEFAULT_SCHEME + relay;
  if (clientUrl(baseUrl) === null) return null;
  return { baseUrl, apiKey };
}

/** Relay-ят за показване: без `https://`, другите схеми остават. Без ключа. */
export function relayLabel(base) {
  const trimmed = String(base ?? '').trim().replace(/\/+$/, '');
  return trimmed.startsWith(DEFAULT_SCHEME) ? trimmed.slice(DEFAULT_SCHEME.length) : trimmed;
}

export function formatConnectionKey(settings) {
  return `${relayLabel(settings.baseUrl)}/${settings.apiKey}`;
}

export function encode(message) {
  return JSON.stringify(message);
}

const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const optId = (v) => (isInt(v) ? v : null);
const strList = (v) => (Array.isArray(v) ? v.filter(isStr) : []);

/**
 * Елементите на масива, които `read` прочита (не `null`); всеки лош отива в `onSkip` с пътя си, без
 * стойност (ЧК5, както `LossyReader` за `list`). `null`, ако полето не е масив.
 */
function readElements(value, path, onSkip, read) {
  if (!Array.isArray(value)) return null;
  const out = [];
  value.forEach((item, index) => {
    const element = read(item);
    if (element == null) onSkip(`${path}[${index}]`);
    else out.push(element);
  });
  return out;
}

const strOrNull = (v) => (isStr(v) ? v : null);

function hostInfo(h) {
  if (!h || !isStr(h.id)) return null;
  return { id: h.id, name: isStr(h.name) ? h.name : null, online: h.online === true };
}

function lanInfo(lan, onSkip) {
  if (!lan || typeof lan !== 'object' || !isInt(lan.port)) return null;
  return { addrs: readElements(lan.addrs, 'lan.addrs', onSkip, strOrNull) ?? [], port: lan.port, fp: isStr(lan.fp) ? lan.fp : '', fpMac: isStr(lan.fpMac) ? lan.fpMac : '' };
}

const terminalSize = (o) => isStr(o.contentId) && isInt(o.cols) && isInt(o.rows);

// КЛ3 (R31 на Mac клиента): `list` се чете елемент по елемент. Лош елемент на масив се пропуска и
// се докладва с пътя си, а не губи целия списък — един таб с непознат вид не бива да скрие всички
// табове. Поле, което изобщо не е масив, прави собственика си лош елемент, а на най-горното ниво —
// целия кадър. Задължителните полета и типовете са тези от `Protocol.kt` на телефона. Една разлика:
// тук `null` в незадължително поле е като липсващо (както в Mac клиента), а Kotlin пропуска елемент
// с `null` в поле без `?` (напр. `focused`). Host-ът не праща `null`, а изпуска полето.
const isBool = (v) => typeof v === 'boolean';
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const STRING_ITEM = { scalar: isStr };
const AGENT = { required: { agent: isStr, activity: isStr } };
const TAB = {
  required: { id: isStr, contentId: isStr },
  // `busy` (КЛ13): затварянето на таба би прекъснало програма на Mac-а; стар host го изпуска.
  optional: { title: isStr, focused: isBool, working: isBool, readOnly: isBool, busy: isBool },
  arrays: { agents: AGENT },
};
const WORKTREE = {
  required: { id: isStr, name: isStr },
  optional: { branch: isStr, status: isStr, focused: isBool, title: isStr, working: isBool, canDeleteWorktree: isBool },
  arrays: { tabs: TAB },
};
const REPOSITORY = {
  required: { id: isStr, name: isStr },
  optional: { group: isStr, canCreateWorktree: isBool },
  arrays: { rowIds: STRING_ITEM, worktrees: WORKTREE },
};
const SECTION = {
  required: { kind: isStr },
  optional: { title: isStr, collapsed: isBool, repositoryId: isStr },
  arrays: { worktreeIds: STRING_ITEM, repositoryIds: STRING_ITEM },
};
const LOAD_FAILURE = { required: { repositoryId: isStr }, optional: { message: isStr } };
const LIST_ARRAYS = { repos: REPOSITORY, sections: SECTION, loadFailures: LOAD_FAILURE };

const SKIP = Symbol('skip');

/** Отговаря ли елементът на скаларния вид или на задължителните и незадължителните полета на `kind`. */
function fitsKind(item, kind) {
  if (kind.scalar) return kind.scalar(item);
  if (!isPlainObject(item)) return false;
  const required = Object.entries(kind.required ?? {}).every(([key, check]) => check(item[key]));
  return required && Object.entries(kind.optional ?? {}).every(([key, check]) => item[key] == null || check(item[key]));
}

/**
 * Четенето елемент по елемент. `onSkip` е в обекта, защото минава през всяко ниво; вътрешен елемент
 * получава свой читател, за да се докладва пропуснатото в него само ако самият той се чете.
 */
class LossyReader {
  #onSkip;

  constructor(onSkip) {
    this.#onSkip = onSkip;
  }

  /**
   * Копие на `obj`, в което масивите от `arrays` държат само елементите, които се четат; `null`,
   * ако някое от тези полета изобщо не е масив — тогава собственикът му не се чете.
   */
  readableArrays(obj, arrays, path) {
    const out = { ...obj };
    for (const [key, kind] of Object.entries(arrays)) {
      const value = obj[key];
      if (value == null) continue;
      if (!Array.isArray(value)) return null;
      const arrayPath = path ? `${path}.${key}` : key;
      out[key] = value.map((item, index) => this.#readable(item, kind, `${arrayPath}[${index}]`)).filter((item) => item !== SKIP);
    }
    return out;
  }

  /**
   * Елементът с прочетените вътрешни масиви или `SKIP`. В `onSkip` отиват само имената на полетата
   * и индексите, никога стойност. Пропуснатото вътре в лош елемент не се докладва: пропуска се целият.
   */
  #readable(item, kind, path) {
    if (!fitsKind(item, kind)) return this.#skip(path);
    if (kind.scalar) return item;
    const inner = [];
    const clean = new LossyReader((p) => inner.push(p)).readableArrays(item, kind.arrays ?? {}, path);
    if (clean == null) return this.#skip(path);
    inner.forEach(this.#onSkip);
    return clean;
  }

  #skip(path) {
    this.#onSkip(path);
    return SKIP;
  }
}

function decodeList(o, onSkip) {
  const clean = new LossyReader(onSkip).readableArrays(o, LIST_ARRAYS, '');
  if (clean == null) return null;
  return { ...clean, id: optId(o.id), repos: clean.repos ?? [], sections: clean.sections ?? [] };
}

/**
 * Декодер за всеки тип съобщение. `null` при липсващо задължително поле; полета, които host-ът
 * може да изпусне, получават стойност по подразбиране.
 */
const DECODERS = {
  relay: (o, onSkip) => ({
    t: 'relay',
    hostOnline: o.hostOnline === true,
    host: isStr(o.host) ? o.host : null,
    // Липсващо поле (стар relay) не е същото като празен списък (нов relay без Mac-ове).
    hosts: readElements(o.hosts, 'hosts', onSkip, hostInfo),
  }),
  hello: (o, onSkip) => ({
    t: 'hello', v: isInt(o.v) ? o.v : PROTOCOL_VERSION,
    host: isStr(o.host) ? o.host : null,
    hostId: isStr(o.hostId) ? o.hostId : null,
    // Версията на Supacode („Supacode 0.11.5 (154)“); стар host я изпуска.
    app: isStr(o.app) && o.app ? o.app : null,
    // Стар host изпуска `caps`: празен списък значи „нищо отгоре на основните съобщения“. Преди
    // `lan`, за да докладва пропуснатото в същия ред като телефона.
    caps: readElements(o.caps, 'caps', onSkip, strOrNull) ?? [],
    lan: lanInfo(o.lan, onSkip),
  }),
  // Отговорът на `watch`; `on` казва дали връзката още гледа.
  watch: (o) => ({ t: 'watch', id: optId(o.id), on: o.on === true }),
  // Списъкът минава до екрана почти както е, но без елементите, които не се четат (КЛ3);
  // непознатите полета (напр. `layout`) остават.
  list: decodeList,
  attached: (o) => (terminalSize(o) ? { t: 'attached', id: optId(o.id), contentId: o.contentId, cols: o.cols, rows: o.rows } : null),
  out: (o) => (isStr(o.contentId) && isStr(o.b64) ? { t: 'out', contentId: o.contentId, b64: o.b64 } : null),
  size: (o) => (terminalSize(o) ? { t: 'size', contentId: o.contentId, cols: o.cols, rows: o.rows } : null),
  detached: (o) => (isStr(o.contentId) ? { t: 'detached', contentId: o.contentId, reason: isStr(o.reason) ? o.reason : null } : null),
  suggest: (o) => (isStr(o.contentId) ? { t: 'suggest', id: optId(o.id), contentId: o.contentId, suggestions: strList(o.suggestions) } : null),
  'tab.new': (o) => (isStr(o.contentId)
    ? { t: 'tab.new', id: optId(o.id), worktreeId: isStr(o.worktreeId) ? o.worktreeId : '', tabId: isStr(o.tabId) ? o.tabId : '', contentId: o.contentId }
    : null),
  // ЗД11: успех и без `tabId`/`contentId` — worktree-то е създадено, но първият му таб не е
  // дошъл; затова тук не се иска `contentId`, както при `tab.new`.
  'worktree.new': (o) => (isStr(o.worktreeId)
    ? {
      t: 'worktree.new', id: optId(o.id), repositoryId: isStr(o.repositoryId) ? o.repositoryId : '',
      worktreeId: o.worktreeId, name: isStr(o.name) ? o.name : '',
      tabId: isStr(o.tabId) ? o.tabId : null, contentId: isStr(o.contentId) ? o.contentId : null,
    }
    : null),
  // ЗД13: worktree-то е изтрито; branch-ът остава.
  'worktree.delete': (o) => (isStr(o.worktreeId)
    ? { t: 'worktree.delete', id: optId(o.id), worktreeId: o.worktreeId, repositoryId: isStr(o.repositoryId) ? o.repositoryId : '' }
    : null),
  // `code` (напр. `resize_failed`) и `contentId` са незадължителни: стар host ги изпуска, а
  // непознат `code` страницата показва като обикновена грешка с `message`.
  error: (o) => ({
    t: 'error', id: optId(o.id), message: isStr(o.message) ? o.message : '',
    code: isStr(o.code) ? o.code : null, contentId: isStr(o.contentId) ? o.contentId : null,
  }),
};

function parseObject(text) {
  try {
    const o = JSON.parse(text);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/**
 * Чете съобщение от relay-а или от host-а. `null` за `ping`/`pong`, счупен JSON, непознат
 * тип или липсващо задължително поле: нищо от relay-а не бива да спира връзката. Пропуснат
 * елемент на `list` отива в `onSkip` с пътя си (`repos[0].worktrees[1]`).
 */
export function decode(text, onSkip = () => {}) {
  if (text === PING || text === PONG) return null;
  const o = parseObject(text);
  const decoder = o && Object.hasOwn(DECODERS, o.t) ? DECODERS[o.t] : null;
  return decoder ? decoder(o, onSkip) : null;
}

/** Съобщения, които носят потока на терминала (виж TerminalStreamGate). */
export function isTerminalStream(message) {
  return ['attached', 'out', 'size', 'detached'].includes(message?.t);
}
