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

/**
 * Чете съобщение от relay-а или от host-а. `null` за `ping`/`pong`, счупен JSON, непознат
 * тип или липсващо задължително поле: нищо от relay-а не бива да спира връзката. Полета,
 * които host-ът може да изпусне, получават стойност по подразбиране.
 */
export function decode(text) {
  if (text === PING || text === PONG) return null;
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  switch (o.t) {
    case 'relay':
      return {
        t: 'relay',
        hostOnline: o.hostOnline === true,
        host: isStr(o.host) ? o.host : null,
        // Липсващо поле (стар relay) не е същото като празен списък (нов relay без Mac-ове).
        hosts: Array.isArray(o.hosts) ? o.hosts.map(hostInfo).filter(Boolean) : null,
      };
    case 'hello':
      return {
        t: 'hello', v: isInt(o.v) ? o.v : PROTOCOL_VERSION,
        host: isStr(o.host) ? o.host : null,
        hostId: isStr(o.hostId) ? o.hostId : null,
        lan: lanInfo(o.lan),
      };
    case 'list':
      // Списъкът минава до екрана почти както е: там непознати стойности се търпят поотделно.
      return { ...o, id: optId(o.id), repos: Array.isArray(o.repos) ? o.repos : [], sections: Array.isArray(o.sections) ? o.sections : [] };
    case 'attached':
      if (!isStr(o.contentId) || !isInt(o.cols) || !isInt(o.rows)) return null;
      return { t: 'attached', id: optId(o.id), contentId: o.contentId, cols: o.cols, rows: o.rows };
    case 'out':
      if (!isStr(o.contentId) || !isStr(o.b64)) return null;
      return { t: 'out', contentId: o.contentId, b64: o.b64 };
    case 'size':
      if (!isStr(o.contentId) || !isInt(o.cols) || !isInt(o.rows)) return null;
      return { t: 'size', contentId: o.contentId, cols: o.cols, rows: o.rows };
    case 'detached':
      if (!isStr(o.contentId)) return null;
      return { t: 'detached', contentId: o.contentId, reason: isStr(o.reason) ? o.reason : null };
    case 'suggest':
      if (!isStr(o.contentId)) return null;
      return { t: 'suggest', id: optId(o.id), contentId: o.contentId, suggestions: strList(o.suggestions) };
    case 'tab.new':
      if (!isStr(o.contentId)) return null;
      return {
        t: 'tab.new', id: optId(o.id), worktreeId: isStr(o.worktreeId) ? o.worktreeId : '',
        tabId: isStr(o.tabId) ? o.tabId : '', contentId: o.contentId,
      };
    case 'error':
      return { t: 'error', id: optId(o.id), message: isStr(o.message) ? o.message : '' };
    default:
      return null;
  }
}

/** Съобщения, които носят потока на терминала (виж TerminalStreamGate). */
export function isTerminalStream(message) {
  return ['attached', 'out', 'size', 'detached'].includes(message?.t);
}
