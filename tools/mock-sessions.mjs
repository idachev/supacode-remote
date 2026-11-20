// Сесиите на mock-а: един shell на contentId, жив между attach-овете, както zmx на Mac-а; `attach`,
// `detach` и `resize` към тях и задържаният размер (`resize` с `hold:true`).

import { attachedClients, send } from './mock-clients.mjs';
import { ATTACH_LIMIT, COLS, HOLD_GRACE_MS, ROWS } from './mock-config.mjs';
import { hosts } from './mock-hosts.mjs';
import { log } from './mock-log.mjs';
import { spawnShell } from './mock-shell.mjs';

const SCREEN_BUFFER_BYTES = 64 * 1024;

/**
 * Сесиите са по Mac (`host.sessions`): contentId → { host, contentId, proc, cols, rows, screen,
 * screenBytes, line }. Сесията знае своя Mac и таб, за да ги ползват командите на реда.
 */
export function session(host, contentId, { cols, rows } = { cols: COLS, rows: ROWS }) {
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
export function stopSession(host, contentId) {
  const s = host.sessions.get(contentId);
  if (!s) return;
  endHold(s, { restore: false });
  s.proc.kill();
}

/** Mac-ът сам сменя pane-а си. Задържан размер не се мени: само се запомня новият размер на Mac-а. */
export function resizeFromMac(s, cols, rows) {
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
export function orphanHolds(c) {
  const owned = [...hosts.values()].flatMap((host) => [...host.sessions.values()]).filter((s) => s.hold?.owner === c);
  for (const s of owned) {
    s.hold.owner = null;
    log('hold orphaned', { host: s.host.id, content: s.contentId, grace_ms: HOLD_GRACE_MS });
    s.hold.graceTimer = setTimeout(() => endHold(s, { restore: true }), HOLD_GRACE_MS);
  }
}

/** Тази връзка става собственик на размера; таймерът без собственик (ако тече) спира. */
function takeHold(s, c) {
  clearTimeout(s.hold?.graceTimer);
  s.hold = { owner: c, graceTimer: null };
}

/** Само таб с поне един агент в `list`, който не е read-only, получава Ctrl+L след задържан resize. */
function wantsCtrlL(host, contentId) {
  return host.repos.some((r) => r.worktrees.some((w) => w.tabs.some((t) => t.contentId === contentId && !t.readOnly && t.agents?.length > 0)));
}

// ---- Съобщенията от клиента към терминала ----

/** Старият host не знае `keep`: всеки attach откача другите, както преди. */
const keepsOthers = (host, msg) => msg.keep === true && host.id !== 'default';

/** Непознат таб или таванът на attach-овете с `keep`: грешката тръгва към клиента и връща `true`. */
function refuseAttach(c, host, msg) {
  if (!host.knownContent.has(msg.contentId)) {
    send(c, { t: 'error', id: msg.id ?? null, message: `unknown content ${msg.contentId}` });
    return true;
  }
  if (!keepsOthers(host, msg) || c.attachments.has(msg.contentId) || c.attachments.size < ATTACH_LIMIT) return false;
  log('attach refused', { host: host.id, content: msg.contentId, client: c.id, attached: c.attachments.size });
  send(c, { t: 'error', id: msg.id ?? null, code: 'attach_limit', contentId: msg.contentId, message: 'too many attached terminals' });
  return true;
}

export function attach(c, host, msg) {
  if (refuseAttach(c, host, msg)) return;
  const s = session(host, msg.contentId);
  if (!keepsOthers(host, msg)) {
    // Повторен attach на същия таб пази задържането му; другите табове на връзката се освобождават.
    releaseHolds(c, host, [...c.attachments].filter((id) => id !== msg.contentId));
    c.attachments.clear();
  }
  c.attachments.add(msg.contentId);
  send(c, { t: 'attached', id: msg.id, contentId: msg.contentId, cols: s.cols, rows: s.rows });
  // Първото `out` е „текущият екран“: тук — последните байтове на shell-а.
  send(c, { t: 'out', contentId: msg.contentId, b64: Buffer.concat(s.screen).toString('base64') });
}

export function detach(c, host, msg) {
  releaseHolds(c, host, [msg.contentId]);
  c.attachments.delete(msg.contentId);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hasSize = (msg) => Number.isInteger(msg.cols) && Number.isInteger(msg.rows);

/** Размерът от заявката, ограничен като на Mac-а (20…500 × 5…200); `null`, ако не е даден в двете посоки. */
export function requestedSize(msg) {
  return hasSize(msg) ? { cols: clamp(msg.cols, 20, 500), rows: clamp(msg.rows, 5, 200) } : null;
}

/** Сесията, чийто размер `resize` може да смени: закачен таб и цели `cols`/`rows`; иначе `null`. */
function resizeTarget(c, host, msg) {
  const s = host.sessions.get(msg.contentId);
  if (s && c.attachments.has(msg.contentId) && hasSize(msg)) return s;
  log('resize ignored', { host: host.id, content: msg.contentId ?? null, client: c.id });
  return null;
}

/** `mock-resize-fail`: грешка само на питащия; тя прекратява и задържането. */
function failResize(c, s, msg) {
  log('resize failed', { host: s.host.id, content: msg.contentId, client: c.id });
  endHold(s, { restore: false });
  send(c, { t: 'error', id: msg.id ?? null, message: 'terminal did not start', code: 'resize_failed', contentId: msg.contentId });
}

/**
 * „Размер по този екран“ (ЗД12): само за закачен таб; host-ът ограничава и праща `size` на всички,
 * и когато размерът вече е такъв. Неуспех — `error` с `code:"resize_failed"` само на питащия; той
 * прекратява и задържането. С `hold:true` размерът получава собственик (тази връзка) и Ctrl+L, ако
 * табът има агент; без `hold` задържането свършва, без размерът да се връща.
 */
export function resize(c, host, msg) {
  const s = resizeTarget(c, host, msg);
  if (!s) return;
  if (s.resizeFails) {
    failResize(c, s, msg);
    return;
  }
  const held = msg.hold === true && host.id !== 'default';
  const { cols, rows } = requestedSize(msg);
  if (held) takeHold(s, c);
  else endHold(s, { restore: false });
  log('resize applied', { host: host.id, content: msg.contentId, client: c.id, hold: held, cols, rows });
  resizeSession(s, cols, rows);
  if (held && wantsCtrlL(host, msg.contentId)) sendCtrlL(s);
}

function sendCtrlL(s) {
  s.proc.write(Buffer.from([0x0c]));
  log('ctrl-l sent', { content: s.contentId });
}
