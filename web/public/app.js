// Страницата на уеб app-а: свързва връзката с Node (`link.js`), терминала и екраните. Всичко към
// Mac-а минава през локалния Node сървър; тук са само показването и клавиатурата.

import { renderBanner, renderTerminalBar, renderTerminalStatus, renderTopbar } from './chrome-view.js';
import { $, readJson, toast, writeStorage } from './dom.js';
import { followHostPick, hideHosts, initHostsView, showHosts } from './hosts-view.js';
import { LocalLink } from './link.js';
import { findTab, sessionRows, worktreeOrder } from './session-groups.js';
import { initSessionsView, renderSessions } from './sessions-view.js';
import { initSetupView, setupResult, showSetup } from './setup-view.js';
import {
  closeSuggestions, initSuggestions, requestSuggestions, showSuggestions, suggestionsOpen, toggleLine,
} from './suggestions.js';
import { TerminalView } from './terminal.js';
import { SIDEBAR_KEY, currentTab, newTabFont, nextRef, ui } from './ui-state.js';
import { nextWorktree } from './view-model.js';

function render() {
  renderBanner();
  renderTopbar();
  renderSessions();
  renderTerminalStatus();
}

const link = new LocalLink({ onUp: linkUp, onDown: linkDown, onMessage: (m) => MESSAGES[m.t]?.(m) });

const terminal = new TerminalView($('term'), $('term-area'), {
  onInput: (b64) => {
    if (ui.phase === 'live') link.send({ t: 'input', b64, contentId: ui.openContentId });
  },
});

function linkUp() {
  ui.linkUp = true;
  // След презареждане табът от адреса се отваря наново: attach-ът носи екрана.
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('c');
  if (fromHash) openTab(fromHash);
  render();
}

function linkDown() {
  ui.linkUp = false;
  // Отговорите на чакащите заявки няма да дойдат: Node е рестартиран.
  dropRequests();
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
  ui.state = m;
  followHostPick(pickBefore, m.hostPick === true);
  // Връзката с Mac-а падна: Node ще закачи таба наново, щом се върне.
  if (m.hostSession == null && ui.phase === 'live') ui.phase = 'opening';
  if (m.connection === 'unauthorized' || !m.configured) showSetup();
  render();
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
  renderSessions();
  renderTopbar();
  renderTerminalBar();
}

function onAttached(m) {
  ui.phase = 'live';
  terminal.init(m.cols, m.rows);
  renderTerminalStatus();
  terminal.focus();
}

/**
 * `size` за отворения таб. Шрифтът се задържа само когато това е поисканият размер (потвърден
 * „Размер по този екран“); всеки друг `size` е размерът на Mac-а и шрифтът се вписва.
 */
function onSize(m) {
  const asked = ui.pendingResize;
  ui.pendingResize = null;
  if (asked?.contentId === m.contentId && asked.cols === m.cols && asked.rows === m.rows) terminal.holdFont(asked);
  terminal.resize(m.cols, m.rows);
}

function onDetached(m) {
  ui.phase = 'ended';
  ui.endReason = m.reason || 'табът е затворен';
  renderTerminalStatus();
}

function onTabNew(m) {
  if (m.ref !== ui.newTabRef) return;
  finishNewTab();
  openTab(m.contentId);
}

function onSuggest(m) {
  if (m.ref !== ui.suggestRef) return;
  ui.suggestRef = null;
  showSuggestions(m.suggestions);
}

function onError(m) {
  if (m.ref && m.ref === ui.newTabRef) finishNewTab();
  if (m.ref && m.ref === ui.suggestRef) closeSuggestions();
  toast(m.message || 'Грешка от host-а');
}

function onReplaced() {
  // Отговорите вече отиват към другата страница.
  dropRequests();
  $('replaced').hidden = false;
}

/** Нов ключ или нов Mac: табът и списъкът са на старата връзка. */
function onReset() {
  ui.list = null;
  ui.listText = '';
  ui.openContentId = null;
  ui.phase = 'none';
  ui.pendingResize = null;
  terminal.releaseFont();
  terminal.clear();
  history.replaceState(null, '', location.pathname);
  dropRequests();
  render();
}

/** Кадрите на терминала стигат само за отворения таб. */
const forOpenTab = (handler) => (m) => {
  if (m.contentId === ui.openContentId) handler(m);
};

const MESSAGES = {
  state: onState,
  list: onList,
  attached: forOpenTab(onAttached),
  out: forOpenTab((m) => terminal.write(m.b64)),
  size: forOpenTab(onSize),
  detached: forOpenTab(onDetached),
  'tab.new': onTabNew,
  suggest: onSuggest,
  error: onError,
  'setup.result': setupResult,
  replaced: onReplaced,
  reset: onReset,
};

// ---- табове ----

function openTab(contentId) {
  if (!contentId) return;
  closeSuggestions();
  ui.openContentId = contentId;
  ui.phase = 'opening';
  ui.endReason = null;
  // Задържаният шрифт и чакащият размер са на предишния таб.
  ui.pendingResize = null;
  terminal.releaseFont();
  terminal.clear();
  history.replaceState(null, '', `#c=${encodeURIComponent(contentId)}`);
  const found = findTab(ui.list, contentId);
  if (found) ui.expanded.add(found.worktree.id);
  link.send({ t: 'open', contentId });
  render();
}

function newTab(worktreeId) {
  if (!worktreeId || ui.newTabRef) return;
  // Началният размер: колкото влиза в мястото при шрифта за нови табове (ОП27).
  const grid = terminal.gridAt(newTabFont());
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
  const fontPx = newTabFont();
  const grid = terminal.gridAt(fontPx);
  if (ui.phase !== 'live' || !grid) return;
  // Шрифтът се задържа чак при потвърждението (`onSize`), не сега.
  ui.pendingResize = { contentId: ui.openContentId, ...grid, fontPx };
  link.send({ t: 'resize', contentId: ui.openContentId, cols: grid.cols, rows: grid.rows });
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

async function copyAll() {
  try {
    await navigator.clipboard.writeText(terminal.allText());
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
  terminal.focus();
}

function takeOver() {
  $('replaced').hidden = true;
  link.send({ t: 'takeover' });
  if (ui.openContentId) openTab(ui.openContentId);
}

function closeDialog(id) {
  $(id).hidden = true;
  terminal.focus();
}

function wireControls() {
  const on = (id, event, handler) => $(id).addEventListener(event, handler);
  on('setup-button', 'click', showSetup);
  on('banner-retry', 'click', () => link.send({ t: 'reconnect' }));
  on('term-retry', 'click', () => openTab(ui.openContentId));
  on('takeover', 'click', takeOver);
  on('host-name', 'click', showHosts);
  on('hosts-close', 'click', () => { hideHosts(); terminal.focus(); });
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

initSessionsView({ openTab, newTab });
initHostsView((id) => link.send({ t: 'host.select', id }));
initSetupView({ onSave: (connectionKey) => link.send({ t: 'setup', connectionKey }), onClosed: () => terminal.focus() });
initSuggestions({ link, terminal });
wireControls();
toggleSidebar(readJson(SIDEBAR_KEY, false) === true);
render();
