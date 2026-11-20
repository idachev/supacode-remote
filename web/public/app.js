// Страницата на уеб app-а: свързва връзката с Node (`link.js`), терминала и екраните. Всичко към
// Mac-а минава през локалния Node сървър; тук са само показването и клавиатурата.

import { renderBanner, renderTerminalBar, renderTerminalStatus, renderTopbar } from './chrome-view.js';
import { $, readJson, toast, writeStorage } from './dom.js';
import { followHostPick, hideHosts, initHostsView, showHosts } from './hosts-view.js';
import { LocalLink } from './link.js';
import {
  currentTerminal, disposeTerminals, forTerminal, initLiveTerminals, markReattach, releaseTerminal, showBlank, showTerminal,
  syncPhase,
} from './live-terminals.js';
import { initNotifyView, notifyAwaiting, resetAwaiting } from './notify-view.js';
import {
  RESIZE_FAILED, RESIZE_REPLY_MS, RESIZE_SILENT, resizeAskText, resizeFailedText, resizeReplyText, withHostApp,
} from './resize-feedback.js';
import { findTab, sessionRows, worktreeOrder } from './session-groups.js';
import { initSessionsView, renderSessions } from './sessions-view.js';
import { initSetupView, setupResult, showSetup } from './setup-view.js';
import {
  closeSuggestions, initSuggestions, requestSuggestions, restoreLine, showSuggestions, suggestionsOpen, toggleLine,
} from './suggestions.js';
import { SIDEBAR_KEY, currentTab, newTabFont, nextRef, ui } from './ui-state.js';
import { nextWorktree } from './view-model.js';
import { closeWorktreeDialog, initWorktreeDialog, openWorktreeDialog, renderWorktreeDialog } from './worktree-dialog.js';
import {
  WORKTREE_REPLIES, askDeleteWorktree, dropWorktreeRequests, handleWorktreeError, initWorktreeRequests, newWorktree,
  renderRefresh, worktreeErrorText,
} from './worktree-requests.js';

function render() {
  renderBanner();
  renderTopbar();
  renderSessions();
  renderTerminalStatus();
  renderRefresh();
}

const link = new LocalLink({ onUp: linkUp, onDown: linkDown, onMessage: (m) => MESSAGES[m.t]?.(m) });
initLiveTerminals({ link, copyText });

/** Делегат за модулите, които само фокусират терминала. */
const terminalFocus = { focus: () => currentTerminal().focus() };

/** Колоните и редовете, които влизат тук при шрифта за нови табове (ОП27); `null` без място. */
const newTabGrid = () => currentTerminal().gridAt(newTabFont());

function linkUp() {
  ui.linkUp = true;
  // След презареждане табът от адреса се отваря наново: attach-ът носи екрана.
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('c');
  if (fromHash) openTab(fromHash);
  render();
}

function linkDown() {
  ui.linkUp = false;
  // Отговорите на чакащите заявки няма да дойдат: Node е рестартиран. Живите терминали Node
  // пуска без страница; табът от адреса се отваря наново при `linkUp`.
  dropRequests();
  disposeTerminals();
  syncPhase();
  render();
}

// ---- съобщенията от Node ----

function onState(m) {
  // Сървърът е пуснат наново (може и с нов код): страницата се зарежда наново, табът — от адреса.
  if (ui.state?.bootId && m.bootId !== ui.state.bootId) {
    location.reload();
    return;
  }
  const pickBefore = ui.state?.hostPick === true;
  const sessionBefore = ui.state?.hostSession;
  ui.state = m;
  followHostPick(pickBefore, m.hostPick === true);
  if (m.hostSession !== sessionBefore) markReattach(m.hostSession);
  if (m.connection === 'unauthorized' || !m.configured) showSetup();
  render();
  renderWorktreeDialog();
}

function onList(m) {
  // Списъкът идва на 3 s; без промяна не се прерисува (иначе губи hover и фокуса на бутоните).
  const text = JSON.stringify(m);
  if (text === ui.listText) return;
  ui.listText = text;
  // Първият списък след презареждане: worktree-то на отворения таб се разгъва.
  const found = !ui.list && ui.openContentId ? findTab(m, ui.openContentId) : null;
  if (found) ui.expanded.add(found.worktree.id);
  ui.list = m;
  notifyAwaiting(m);
  renderSessions();
  // Подсказката „вече има“ е по пълния списък, а той може да се е сменил.
  renderWorktreeDialog();
  renderRefresh();
  renderTopbar();
  renderTerminalBar();
}

function onAttached(entry, m, visible) {
  entry.phase = 'live';
  entry.endReason = null;
  entry.view.init(m.cols, m.rows);
  if (!visible) return;
  syncPhase();
  renderTerminalStatus();
  entry.view.focus();
}

/**
 * `size` за отворения таб: шрифтът винаги се вписва в размера на Mac-а, и след „Размер по този
 * екран“ (ОП36). Вписаният шрифт излиза малко над този от „Настройка“, но без задържан шрифт
 * няма състояние, което да се разминава с размера, който Mac-ът наистина държи.
 */
function onSize(entry, m) {
  const asked = ui.resizeAsk;
  if (asked?.contentId === m.contentId) {
    cancelResizeAsk();
    toastWithApp(resizeReplyText(asked, m));
  }
  entry.view.resize(m.cols, m.rows);
}

function onDetached(entry, m, visible) {
  entry.phase = 'ended';
  entry.endReason = m.reason || 'табът е затворен';
  if (!visible) return;
  syncPhase();
  renderTerminalStatus();
}

/** Node пусна терминала (LRU, затворен таб, друга страница): xterm.js му се маха. */
function onReleased(m) {
  if (!releaseTerminal(m.contentId) || m.contentId !== ui.openContentId) return;
  showBlank();
  syncPhase();
  render();
}

function onTabNew(m) {
  if (m.ref !== ui.newTabRef) return;
  finishNewTab();
  openTab(m.contentId);
}

function closeOpenTab() {
  ui.openContentId = null;
  // Терминалът му се маха с `released` от Node.
  showBlank();
  syncPhase();
  history.replaceState(null, '', location.pathname);
  link.send({ t: 'close' });
  render();
}

function onSuggest(m) {
  if (m.ref !== ui.suggestRef) return;
  ui.suggestRef = null;
  showSuggestions(m.suggestions);
}

/** Грешката отива при заявката си; без такава — съобщение долу. */
function onError(m) {
  if (m.kind === 'line') {
    restoreLine(m);
    return;
  }
  if (m.code === RESIZE_FAILED && m.contentId === ui.openContentId) {
    onResizeFailed(m);
    return;
  }
  if (handleWorktreeError(m)) return;
  stopWaitingFor(m.ref);
  // Затворен диалог „Нов worktree“: отказът му идва тук, на български за `worktree_timeout`.
  toastWithApp(m.kind === 'worktree.new' ? worktreeErrorText(m) : (m.message || 'Грешка от host-а'));
}

/** „Нов таб“ или „Предложи“ с този `ref` спира да чака: отговорът е грешка. */
function stopWaitingFor(ref) {
  if (!ref) return;
  if (ref === ui.newTabRef) finishNewTab();
  if (ref === ui.suggestRef) closeSuggestions();
}

/**
 * Mac-ът не смени размера: отговорът е дошъл, затова „не отговори“ по-късно би излъгал. Ако PTY-то
 * държи друг размер, `size` с него е дошъл преди грешката и вече е вписал шрифта.
 */
function onResizeFailed(m) {
  cancelResizeAsk();
  toastWithApp(resizeFailedText(m.message));
}

function onReplaced() {
  // Отговорите вече отиват към другата страница.
  dropRequests();
  closeWorktreeDialog();
  $('replaced').hidden = false;
}

/** Нов ключ или нов Mac: табът и списъкът са на старата връзка. */
function onReset() {
  ui.list = null;
  ui.listText = '';
  ui.openContentId = null;
  cancelResizeAsk();
  resetAwaiting();
  disposeTerminals();
  syncPhase();
  history.replaceState(null, '', location.pathname);
  dropRequests();
  closeWorktreeDialog();
  render();
}

const MESSAGES = {
  state: onState,
  list: onList,
  attached: forTerminal(onAttached),
  out: forTerminal((entry, m) => entry.view.write(m.b64)),
  size: forTerminal(onSize),
  detached: forTerminal(onDetached),
  released: onReleased,
  'tab.new': onTabNew,
  ...WORKTREE_REPLIES,
  suggest: onSuggest,
  error: onError,
  'setup.result': setupResult,
  replaced: onReplaced,
  reset: onReset,
};

// ---- табове ----

/**
 * Жив терминал само се показва (Node не праща нищо към Mac-а); нов — `attach` и екранът наново.
 * Затворен (`detached`) таб тръгва отначало: „Свържи отново“.
 */
function openTab(contentId) {
  if (!contentId) return;
  closeSuggestions();
  ui.openContentId = contentId;
  cancelResizeAsk();
  const entry = showTerminal(contentId);
  syncPhase();
  history.replaceState(null, '', `#c=${encodeURIComponent(contentId)}`);
  const found = findTab(ui.list, contentId);
  if (found) ui.expanded.add(found.worktree.id);
  link.send({ t: 'open', contentId });
  render();
  if (ui.phase === 'live') entry.view.focus();
}

function newTab(worktreeId) {
  if (!worktreeId || ui.newTabRef) return;
  // Началният размер: колкото влиза в мястото при шрифта за нови табове (ОП27).
  const grid = newTabGrid();
  ui.newTabRef = nextRef();
  ui.newTabWorktreeId = worktreeId;
  link.send({ t: 'tab.new', worktreeId, cols: grid?.cols, rows: grid?.rows, ref: ui.newTabRef });
  renderSessions();
}

function finishNewTab() {
  ui.newTabRef = null;
  ui.newTabWorktreeId = null;
  renderSessions();
}

function dropRequests() {
  closeSuggestions();
  if (ui.newTabRef) finishNewTab();
  dropWorktreeRequests();
}

function moveTab(step) {
  const tabs = currentTab()?.worktree.tabs ?? [];
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.contentId === ui.openContentId);
  openTab(tabs[(i + step + tabs.length) % tabs.length].contentId);
}

function moveWorktree(step) {
  const order = worktreeOrder(sessionRows(ui.list, ui.collapsed, ''));
  const wt = nextWorktree(order, currentTab()?.worktree.id, step);
  if (wt) openTab((wt.tabs.find((t) => t.focused) ?? wt.tabs[0]).contentId);
}

/** ЗД12: таба на Mac-а с толкова колони и редове, колкото влизат тук при шрифта от „Настройка“. */
function resizeToScreen() {
  const grid = newTabGrid();
  if (ui.phase !== 'live' || !grid) return;
  const ask = resizeAskText(grid, currentTerminal().size());
  toast(ask.text);
  if (!ask.send) return;
  cancelResizeAsk();
  // Отговорът е `size`; без него след малко потребителят разбира, че нищо няма да стане.
  const timer = setTimeout(() => {
    ui.resizeAsk = null;
    toastWithApp(RESIZE_SILENT);
  }, RESIZE_REPLY_MS);
  ui.resizeAsk = { contentId: ui.openContentId, ...grid, timer };
  link.send({ t: 'resize', contentId: ui.openContentId, cols: grid.cols, rows: grid.rows });
}

/** Грешка или отговор от Mac-а: с версията на Supacode там, ако Mac-ът я е казал (УА6). */
function toastWithApp(text, ms) {
  toast(withHostApp(text, ui.state?.hostApp), ms);
}

function cancelResizeAsk() {
  clearTimeout(ui.resizeAsk?.timer);
  ui.resizeAsk = null;
}

function toggleSidebar(hidden = !$('sessions').classList.contains('hidden')) {
  $('sessions').classList.toggle('hidden', hidden);
  writeStorage(SIDEBAR_KEY, hidden);
}

function focusSearch() {
  toggleSidebar(false);
  $('search').focus();
  $('search').select();
}

// ---- клавишни комбинации: Ctrl+⌘ ----

const SHORTCUTS = {
  ArrowUp: () => moveTab(-1),
  ArrowDown: () => moveTab(1),
  ArrowLeft: () => moveWorktree(-1),
  ArrowRight: () => moveWorktree(1),
  n: () => newTab(currentTab()?.worktree.id),
  s: requestSuggestions,
  l: () => toggleLine(),
  b: () => toggleSidebar(),
  // K, а не F: Ctrl+⌘+F е цял екран в macOS.
  k: focusSearch,
};

function consume(e) {
  e.preventDefault();
  e.stopPropagation();
}

/** В capture фазата, за да не стигне комбинацията до xterm.js или до полето. */
function onKeyCapture(e) {
  const shortcut = e.ctrlKey && e.metaKey ? SHORTCUTS[e.key.length === 1 ? e.key.toLowerCase() : e.key] : null;
  if (shortcut) {
    consume(e);
    shortcut();
  } else if (e.key === 'Escape' && suggestionsOpen()) {
    // Esc само затваря предложенията: към агента би прекъснал работата му.
    consume(e);
    closeSuggestions();
  }
}

// ---- бутони и полета ----

function copyAll() {
  return copyText(currentTerminal().allText());
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Копирано');
  } catch {
    toast('Не мога да пиша в clipboard-а');
  }
}

function onSearchKey(e) {
  if (e.key !== 'Escape') return;
  e.target.value = '';
  ui.query = '';
  renderSessions();
  terminalFocus.focus();
}

function takeOver() {
  $('replaced').hidden = true;
  link.send({ t: 'takeover' });
  if (ui.openContentId) openTab(ui.openContentId);
}

function closeDialog(id) {
  $(id).hidden = true;
  terminalFocus.focus();
}

/** Един ред на бутон или поле: какво събитие и какво прави. */
function wireControls() {
  const on = (id, event, handler) => $(id).addEventListener(event, handler);
  on('setup-button', 'click', showSetup);
  on('banner-retry', 'click', () => link.send({ t: 'reconnect' }));
  on('term-retry', 'click', () => openTab(ui.openContentId));
  on('takeover', 'click', takeOver);
  on('host-name', 'click', showHosts);
  on('hosts-close', 'click', () => { hideHosts(); terminalFocus.focus(); });
  on('help-button', 'click', () => { $('help').hidden = false; });
  on('help-close', 'click', () => closeDialog('help'));
  on('suggest-button', 'click', requestSuggestions);
  on('line-button', 'click', () => toggleLine());
  on('copy-all-button', 'click', copyAll);
  on('fit-button', 'click', resizeToScreen);
  on('toggle-sessions', 'click', () => toggleSidebar());
  on('search', 'input', (e) => { ui.query = e.target.value; renderSessions(); });
  on('search', 'keydown', onSearchKey);
  window.addEventListener('keydown', onKeyCapture, true);
}

initSessionsView({ openTab, newTab, newWorktree: openWorktreeDialog, deleteWorktree: askDeleteWorktree });
initWorktreeDialog(newWorktree);
initWorktreeRequests({ link, openTab, closeOpenTab, toastWithApp, newTabGrid, focusTerminal: terminalFocus.focus });
initNotifyView({ onOpen: openTab });
initHostsView((id) => link.send({ t: 'host.select', id }));
initSetupView({ onSave: (connectionKey) => link.send({ t: 'setup', connectionKey }), onClosed: () => terminalFocus.focus() });
initSuggestions({ link, terminal: terminalFocus });
wireControls();
toggleSidebar(readJson(SIDEBAR_KEY, false) === true);
render();
