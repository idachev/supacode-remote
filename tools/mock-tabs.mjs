// Табовете и pane-овете на worktree-тата: `tab.new`, `tab.close`, `pane.split` и `pane.close`.

import { replyUnknownType, send } from './mock-clients.mjs';
import { COLS, ROWS } from './mock-config.mjs';
import { addTabToPane, splitPane } from './mock-layout.mjs';
import { layoutOf } from './mock-list.mjs';
import { log } from './mock-log.mjs';
import { requestedSize, session, stopSession } from './mock-sessions.mjs';

let newTabCounter = 0;

/** Нов shell-таб в worktree-то: добавя го в списъка и пуска сесията му. */
export function createTab(host, worktree, { cols = COLS, rows = ROWS, focused = false } = {}) {
  newTabCounter += 1;
  const contentId = `content-new-${newTabCounter}`;
  const tabId = `tab-new-${newTabCounter}`;
  worktree.tabs.push({ id: tabId, contentId, title: 'zsh', focused, working: false, readOnly: false, agents: [] });
  host.knownContent.add(contentId);
  session(host, contentId, { cols, rows });
  return { tabId, contentId };
}

/**
 * Нов таб: размерът от заявката (ЗД12), ако е даден и в двете посоки, иначе 120 × 40. С `paneId`
 * от `layout` табът отива в този pane; непознат `paneId` се пренебрегва (не-низ спира още
 * `handle`).
 */
export function newTab(c, host, msg) {
  const worktree = host.repos.flatMap((r) => r.worktrees).find((w) => w.id === msg.worktreeId);
  if (!worktree) {
    send(c, { t: 'error', id: msg.id ?? null, message: `unknown worktree ${msg.worktreeId}` });
    return;
  }
  const { cols, rows } = requestedSize(msg) ?? { cols: COLS, rows: ROWS };
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
function layoutError(c, msg, [code, message]) {
  log(`${msg.t} failed`, { code, client: c.id });
  send(c, { t: 'error', id: msg.id ?? null, message, code });
}

export function tabClose(c, host, msg) {
  if (host.id === 'default') return replyUnknownType(c, msg);
  if (typeof msg.tabId !== 'string' || !msg.tabId) return layoutError(c, msg, ['tab_invalid', 'tab.close needs a tabId']);
  const found = findTab(host, msg.tabId);
  if (!found) return layoutError(c, msg, ['tab_invalid', 'no such tab']);
  closeTab(host, found.worktree, found.tab);
  return send(c, { t: 'tab.close', id: msg.id ?? null, tabId: msg.tabId, worktreeId: found.worktree.id });
}

export function paneSplit(c, host, msg) {
  if (host.id === 'default') return replyUnknownType(c, msg);
  if (typeof msg.paneId !== 'string' || !msg.paneId) return layoutError(c, msg, ['pane_invalid', 'pane.split needs a paneId']);
  const found = findPane(host, msg.paneId);
  if (!found) return layoutError(c, msg, ['pane_invalid', 'no such pane']);
  if (msg.direction !== 'horizontal' && msg.direction !== 'vertical') {
    return layoutError(c, msg, ['pane_invalid', 'direction must be horizontal or vertical']);
  }
  const { tabId, contentId } = createTab(host, found.worktree);
  const paneId = splitPane(found.state, msg, tabId);
  log('pane split', { host: host.id, worktree: found.worktree.id, pane: paneId, content: contentId, direction: msg.direction });
  return send(c, { t: 'pane.split', id: msg.id ?? null, worktreeId: found.worktree.id, paneId, tabId, contentId });
}

export function paneClose(c, host, msg) {
  if (host.id === 'default') return replyUnknownType(c, msg);
  if (typeof msg.paneId !== 'string' || !msg.paneId) return layoutError(c, msg, ['pane_invalid', 'pane.close needs a paneId']);
  const found = findPane(host, msg.paneId);
  if (!found) return layoutError(c, msg, ['pane_invalid', 'no such pane']);
  const pane = found.state.panes.find((p) => p.id === msg.paneId);
  for (const tabId of [...pane.tabIds]) {
    const tab = found.worktree.tabs.find((t) => t.id === tabId);
    if (tab) closeTab(host, found.worktree, tab);
  }
  layoutOf(host, found.worktree);
  return send(c, { t: 'pane.close', id: msg.id ?? null, paneId: msg.paneId, worktreeId: found.worktree.id });
}
