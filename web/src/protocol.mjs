// Протоколът v1 от docs/remote-access-protocol.md в repo-то на Supacode, откъм клиента.
// Пренесен от Android (`protocol/Protocol.kt`, `protocol/RelayUrl.kt`), за да говори
// уеб app-ът със същия relay и същия Mac по същия начин.

export const PROTOCOL_VERSION = 1;
export const ATTACH_SCROLLBACK = 500;

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

function hostInfo(h) {
  if (!h || !isStr(h.id)) return null;
  return { id: h.id, name: isStr(h.name) ? h.name : null, online: h.online === true };
}

function lanInfo(lan) {
  if (!lan || typeof lan !== 'object' || !isInt(lan.port)) return null;
  return { addrs: strList(lan.addrs), port: lan.port, fp: isStr(lan.fp) ? lan.fp : '', fpMac: isStr(lan.fpMac) ? lan.fpMac : '' };
}

const terminalSize = (o) => isStr(o.contentId) && isInt(o.cols) && isInt(o.rows);

/**
 * Декодер за всеки тип съобщение. `null` при липсващо задължително поле; полета, които host-ът
 * може да изпусне, получават стойност по подразбиране.
 */
const DECODERS = {
  relay: (o) => ({
    t: 'relay',
    hostOnline: o.hostOnline === true,
    host: isStr(o.host) ? o.host : null,
    // Липсващо поле (стар relay) не е същото като празен списък (нов relay без Mac-ове).
    hosts: Array.isArray(o.hosts) ? o.hosts.map(hostInfo).filter(Boolean) : null,
  }),
  hello: (o) => ({
    t: 'hello', v: isInt(o.v) ? o.v : PROTOCOL_VERSION,
    host: isStr(o.host) ? o.host : null,
    hostId: isStr(o.hostId) ? o.hostId : null,
    // Версията на Supacode („Supacode 0.11.5 (154)“); стар host я изпуска.
    app: isStr(o.app) && o.app ? o.app : null,
    lan: lanInfo(o.lan),
  }),
  // Списъкът минава до екрана почти както е: там непознати стойности се търпят поотделно.
  list: (o) => ({ ...o, id: optId(o.id), repos: Array.isArray(o.repos) ? o.repos : [], sections: Array.isArray(o.sections) ? o.sections : [] }),
  attached: (o) => (terminalSize(o) ? { t: 'attached', id: optId(o.id), contentId: o.contentId, cols: o.cols, rows: o.rows } : null),
  out: (o) => (isStr(o.contentId) && isStr(o.b64) ? { t: 'out', contentId: o.contentId, b64: o.b64 } : null),
  size: (o) => (terminalSize(o) ? { t: 'size', contentId: o.contentId, cols: o.cols, rows: o.rows } : null),
  detached: (o) => (isStr(o.contentId) ? { t: 'detached', contentId: o.contentId, reason: isStr(o.reason) ? o.reason : null } : null),
  suggest: (o) => (isStr(o.contentId) ? { t: 'suggest', id: optId(o.id), contentId: o.contentId, suggestions: strList(o.suggestions) } : null),
  'tab.new': (o) => (isStr(o.contentId)
    ? { t: 'tab.new', id: optId(o.id), worktreeId: isStr(o.worktreeId) ? o.worktreeId : '', tabId: isStr(o.tabId) ? o.tabId : '', contentId: o.contentId }
    : null),
  error: (o) => ({ t: 'error', id: optId(o.id), message: isStr(o.message) ? o.message : '' }),
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
 * тип или липсващо задължително поле: нищо от relay-а не бива да спира връзката.
 */
export function decode(text) {
  if (text === PING || text === PONG) return null;
  const o = parseObject(text);
  const decoder = o && Object.hasOwn(DECODERS, o.t) ? DECODERS[o.t] : null;
  return decoder ? decoder(o) : null;
}

/** Съобщения, които носят потока на терминала (виж TerminalStreamGate). */
export function isTerminalStream(message) {
  return ['attached', 'out', 'size', 'detached'].includes(message?.t);
}
