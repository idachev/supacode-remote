// Страницата на уеб app-а: свързва връзката с Node (`link.js`), терминала и екраните. Всичко към
// Mac-а минава през локалния Node сървър; тук са само показването и клавиатурата.

import { renderBanner, renderTerminalBar, renderTerminalStatus, renderTopbar } from './chrome-view.js';
import { $, readJson, toast, writeStorage } from './dom.js';
import { followHostPick, hideHosts, initHostsView, showHosts } from './hosts-view.js';
import { LocalLink } from './link.js';
import { initNotifyView, notifyAwaiting, resetAwaiting } from './notify-view.js';
import {
  RESIZE_FAILED, RESIZE_REPLY_MS, RESIZE_SILENT, resizeAskText, resizeFailedText, resizeReplyText, withHostApp,
} from './resize-feedback.js';
import { findTab, sessionRows, worktreeOrder } from './session-groups.js';
import { initSessionsView, renderSessions } from './sessions-view.js';
import { initSetupView, setupResult, showSetup } from './setup-view.js';
import {
  closeSuggestions, initSuggestions, requestSuggestions, showSuggestions, suggestionsOpen, toggleLine,
} from './suggestions.js';
import { TerminalView } from './terminal.js';
import { SIDEBAR_KEY, currentTab, newTabFont, nextRef, ui } from './ui-state.js';
import { nextWorktree } from './view-model.js';
import { closeWorktreeDialog, initWorktreeDialog, openWorktreeDialog, renderWorktreeDialog } from './worktree-dialog.js';

/** Отговорът на `worktree.new` не дойде: таймаут или паднала връзка (К2, К3). */
const WORKTREE_UNKNOWN = 'Mac-ът още създава worktree-то или връзката падна, затова не знам как е свършило. Worktree-то може да се появи в списъка по-късно. Можеш да опиташ пак със същото име.';
/** К7, К8: изтриването може още да тече, а отговорът не дойде. */
const DELETE_UNKNOWN = 'Mac-ът още изтрива worktree-то или връзката падна. Worktree-то може да изчезне от списъка по-късно.';
const REFRESH_LATER = 'Mac-ът още чете worktree-тата; опитай пак по-късно.';
/** Тези кодове значат „отговорът няма да дойде“, а не „Mac-ът отказа“. */
const WORKTREE_UNKNOWN_CODES = ['worktree_timeout', 'worktree_lost'];

function render() {
  renderBanner();
  renderTopbar();
  renderSessions();
  renderTerminalStatus();
  renderRefresh();
}

const link = new LocalLink({ onUp: linkUp, onDown: linkDown, onMessage: (m) => MESSAGES[m.t]?.(m) });

const terminal = new TerminalView($('term'), $('term-area'), {
  onInput: (b64) => {
    if (ui.phase === 'live') link.send({ t: 'input', b64, contentId: ui.openContentId });
  },
  // УА4: маркираното в Claude Code (OSC 52) идва тук, не само в clipboard-а на Mac-а.
  onClipboard: (text) => copyText(text),
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

function onAttached(m) {
  ui.phase = 'live';
  terminal.init(m.cols, m.rows);
  renderTerminalStatus();
  terminal.focus();
}

/**
 * `size` за отворения таб: шрифтът винаги се вписва в размера на Mac-а, и след „Размер по този
 * екран“ (ОП36). Вписаният шрифт излиза малко над този от „Настройка“, но без задържан шрифт
 * няма състояние, което да се разминава с размера, който Mac-ът наистина държи.
 */
function onSize(m) {
  const asked = ui.resizeAsk;
  if (asked?.contentId === m.contentId) {
    cancelResizeAsk();
    toastWithApp(resizeReplyText(asked, m));
  }
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

/** Новият worktree е готов: разгъва се и първият му таб се отваря, както след „Нов таб“. */
function onWorktreeNew(m) {
  if (!ui.newWorktree || m.ref !== ui.newWorktree.ref) {
    // Диалогът е затворен, докато Mac-ът създаваше (ЗД11): само се казва, че е готово.
    toast(`Worktree-то „${m.name}“ е създадено`);
    return;
  }
  closeWorktreeDialog();
  ui.expanded.add(m.worktreeId);
  if (m.contentId) openTab(m.contentId);
  else toast(`Worktree-то „${m.name}“ е създадено, но първият му таб не се отвори. Отвори „+ Нов таб“ под него.`);
  renderSessions();
}

/** `worktree_timeout` носи английски текст от Mac-а; на потребителя се казва на български. */
function worktreeErrorText(m) {
  return WORKTREE_UNKNOWN_CODES.includes(m.code) ? WORKTREE_UNKNOWN : (m.message || 'Грешка от host-а');
}

/** Грешката за отворения диалог стои в него, с името, за да се поправи и пусне пак. */
function onWorktreeError(m) {
  ui.newWorktree.ref = null;
  ui.newWorktree.error = worktreeErrorText(m);
  renderWorktreeDialog();
  renderSessions();
}

// ---- изтриване и „Опресни“ (ЗД13) ----

function askDeleteWorktree(worktree, repositoryName) {
  ui.confirmDelete = { worktreeId: worktree.id, name: worktree.name, repositoryName };
  $('confirm-delete-text').textContent =
    `Изтрий worktree ${worktree.name} в ${repositoryName}? Папката и терминалите му се затварят; branch-ът остава.`;
  $('confirm-delete').hidden = false;
  $('confirm-delete-ok').focus();
}

function closeConfirmDelete() {
  ui.confirmDelete = null;
  $('confirm-delete').hidden = true;
}

function confirmDeleteWorktree() {
  const ask = ui.confirmDelete;
  closeConfirmDelete();
  if (!ask || ui.deleting.has(ask.worktreeId)) return;
  const ref = nextRef();
  if (!link.send({ t: 'worktree.delete', worktreeId: ask.worktreeId, ref })) {
    toast('Няма връзка — не е изпратено');
    return;
  }
  // Отвореният таб се помни сега: списъкът може да изгуби worktree-то преди отговора.
  const openInside = currentTab()?.worktree.id === ask.worktreeId ? ui.openContentId : null;
  ui.deleting.set(ask.worktreeId, { ref, name: ask.name, openInside });
  renderSessions();
}

/** Изтриването, на което е този `ref`, или `null`. */
function deletingFor(ref) {
  for (const [worktreeId, d] of ui.deleting) if (ref && d.ref === ref) return { worktreeId, ...d };
  return null;
}

function onWorktreeDelete(m) {
  const d = deletingFor(m.ref);
  if (!d) return;
  ui.deleting.delete(d.worktreeId);
  toast(`Изтрих „${d.name}“`);
  // Отвореният таб беше в изтрития worktree: терминалът му е затворен, екранът се чисти.
  if (d.openInside && d.openInside === ui.openContentId) closeOpenTab();
  renderSessions();
}

function onDeleteError(d, m) {
  ui.deleting.delete(d.worktreeId);
  const lost = WORKTREE_UNKNOWN_CODES.includes(m.code);
  // `worktree_dirty` изброява файловете: стои по-дълго, за да се прочете.
  toastWithApp(lost ? DELETE_UNKNOWN : `Не изтрих „${d.name}“: ${m.message || 'грешка от Mac-а'}`, m.code === 'worktree_dirty' ? 12_000 : undefined);
  renderSessions();
}

function refreshWorktrees() {
  if (ui.refreshRef || !ui.list?.canRefreshWorktrees) return;
  const ref = nextRef();
  if (!link.send({ t: 'worktrees.refresh', ref })) {
    toast('Няма връзка — не е изпратено');
    return;
  }
  ui.refreshRef = ref;
  renderRefresh();
}

function onRefreshDone(m) {
  if (!m.ref || m.ref !== ui.refreshRef) return;
  ui.refreshRef = null;
  renderRefresh();
}

function renderRefresh() {
  const button = $('refresh-button');
  button.hidden = ui.list?.canRefreshWorktrees !== true;
  button.disabled = ui.refreshRef != null || ui.state?.hostSession == null;
}

function closeOpenTab() {
  ui.openContentId = null;
  ui.phase = 'none';
  terminal.clear();
  history.replaceState(null, '', location.pathname);
  link.send({ t: 'close' });
  render();
}

function onSuggest(m) {
  if (m.ref !== ui.suggestRef) return;
  ui.suggestRef = null;
  showSuggestions(m.suggestions);
}

function onError(m) {
  if (m.code === RESIZE_FAILED && m.contentId === ui.openContentId) {
    onResizeFailed(m);
    return;
  }
  if (m.ref && m.ref === ui.newWorktree?.ref) {
    onWorktreeError(m);
    return;
  }
  const deleting = deletingFor(m.ref);
  if (deleting) {
    onDeleteError(deleting, m);
    return;
  }
  if (m.ref && m.ref === ui.refreshRef) {
    onRefreshDone(m);
    toastWithApp(WORKTREE_UNKNOWN_CODES.includes(m.code) || m.code === 'refresh_timeout'
      ? REFRESH_LATER : `Не опресних: ${m.message || 'грешка от Mac-а'}`);
    return;
  }
  if (m.ref && m.ref === ui.newTabRef) finishNewTab();
  if (m.ref && m.ref === ui.suggestRef) closeSuggestions();
  // Затворен диалог „Нов worktree“: отказът му идва тук, на български за `worktree_timeout`.
  toastWithApp(m.kind === 'worktree.new' ? worktreeErrorText(m) : (m.message || 'Грешка от host-а'));
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
  ui.phase = 'none';
  cancelResizeAsk();
  resetAwaiting();
  terminal.clear();
  history.replaceState(null, '', location.pathname);
  dropRequests();
  closeWorktreeDialog();
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
  'worktree.new': onWorktreeNew,
  'worktree.delete': onWorktreeDelete,
  'worktrees.refresh': onRefreshDone,
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
  cancelResizeAsk();
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

/** ЗД11: `cols`/`rows` на първия таб — както при „Нов таб“ (ОП27); Mac-ът после взима своя размер. */
function newWorktree(d) {
  if (d.ref) return;
  const grid = terminal.gridAt(newTabFont());
  const ref = nextRef();
  if (!link.send({ t: 'worktree.new', repositoryId: d.repositoryId, name: d.name.trim(), cols: grid?.cols, rows: grid?.rows, ref })) {
    d.error = 'Няма връзка — не е изпратено';
    renderWorktreeDialog();
    return;
  }
  d.ref = ref;
  d.error = null;
  renderWorktreeDialog();
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
  if (ui.newWorktree?.ref) onWorktreeError({ code: 'worktree_lost' });
  if (ui.deleting.size) toast(DELETE_UNKNOWN);
  ui.deleting.clear();
  ui.refreshRef = null;
  closeConfirmDelete();
  renderRefresh();
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
  const grid = terminal.gridAt(newTabFont());
  if (ui.phase !== 'live' || !grid) return;
  const ask = resizeAskText(grid, terminal.size());
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
  return copyText(terminal.allText());
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
  on('refresh-button', 'click', refreshWorktrees);
  on('confirm-delete-cancel', 'click', () => { closeConfirmDelete(); terminal.focus(); });
  on('confirm-delete-ok', 'click', confirmDeleteWorktree);
  on('confirm-delete', 'keydown', (e) => { if (e.key === 'Escape') closeConfirmDelete(); });
  on('toggle-sessions', 'click', () => toggleSidebar());
  on('search', 'input', (e) => { ui.query = e.target.value; renderSessions(); });
  on('search', 'keydown', onSearchKey);
  window.addEventListener('keydown', onKeyCapture, true);
}

initSessionsView({ openTab, newTab, newWorktree: openWorktreeDialog, deleteWorktree: askDeleteWorktree });
initWorktreeDialog(newWorktree);
initNotifyView({ onOpen: openTab });
initHostsView((id) => link.send({ t: 'host.select', id }));
initSetupView({ onSave: (connectionKey) => link.send({ t: 'setup', connectionKey }), onClosed: () => terminal.focus() });
initSuggestions({ link, terminal });
wireControls();
toggleSidebar(readJson(SIDEBAR_KEY, false) === true);
render();
