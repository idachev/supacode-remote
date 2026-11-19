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

// ---- живите терминали (ДЗ23) ----
//
// По един `TerminalView` за всеки терминал от набора на Node: скритите са в същия контейнер и пак
// пишат изхода си, затова връщането към таба е без мрежа и със същия скрол. Node казва с
// `released`, кога терминал излиза от набора. `blank` е празният терминал без отворен таб: по него
// се мери мястото за нов таб.

/** contentId → `{view, phase, endReason}`; `phase` е като `ui.phase`, но за този терминал. */
const terminals = new Map();

function makeView(contentId) {
  const box = document.createElement('div');
  box.className = 'term-view';
  $('term').append(box);
  return new TerminalView(box, $('term-area'), {
    // Вход само от видимия таб (АЦ1): скрит терминал не бива да пише в своя PTY.
    onInput: (b64) => {
      if (contentId && contentId === ui.openContentId && ui.phase === 'live') link.send({ t: 'input', b64, contentId });
    },
    // УА4: маркираното в Claude Code (OSC 52) идва тук, не само в clipboard-а на Mac-а; от скрит таб — не.
    onClipboard: (text) => {
      if (contentId === ui.openContentId) copyText(text);
    },
  });
}

const blank = makeView(null);

/** Терминалът пред очите: на отворения таб или празният. */
function currentTerminal() {
  return terminals.get(ui.openContentId)?.view ?? blank;
}

function showOnly(view) {
  blank.show(blank === view);
  for (const entry of terminals.values()) entry.view.show(entry.view === view);
}

/** `ui.phase` е фазата на видимия терминал. */
function syncPhase() {
  const entry = terminals.get(ui.openContentId);
  ui.phase = entry ? entry.phase : 'none';
  ui.endReason = entry?.endReason ?? null;
}

function disposeTerminals() {
  for (const entry of terminals.values()) entry.view.dispose();
  terminals.clear();
  blank.clear();
  showOnly(blank);
}

/** Делегат за модулите, които само фокусират терминала. */
const terminalFocus = { focus: () => currentTerminal().focus() };

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

/**
 * Нова сесия с Mac-а: той е забравил attach-овете. Node закача видимия веднага (без сесия —
 * щом се върне), а скритите — когато се покажат; дотогава те не са „на живо“.
 */
function markReattach(hostSession) {
  for (const [contentId, entry] of terminals) {
    const visible = contentId === ui.openContentId;
    if (entry.phase === 'live' && (!visible || hostSession == null)) entry.phase = 'opening';
  }
  syncPhase();
}

/** Кадрите на терминала стигат до своя `TerminalView`; за пуснат терминал — до никого. */
const forTerminal = (handler) => (m) => {
  const entry = terminals.get(m.contentId);
  if (entry) handler(entry, m, m.contentId === ui.openContentId);
};

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
  const entry = terminals.get(m.contentId);
  if (!entry) return;
  entry.view.dispose();
  terminals.delete(m.contentId);
  if (m.contentId !== ui.openContentId) return;
  showOnly(blank);
  syncPhase();
  render();
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
  // Терминалът му се маха с `released` от Node.
  showOnly(blank);
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

/**
 * Жив терминал само се показва (Node не праща нищо към Mac-а); нов — `attach` и екранът наново.
 * Затворен (`detached`) таб тръгва отначало: „Свържи отново“.
 */
function openTab(contentId) {
  if (!contentId) return;
  closeSuggestions();
  ui.openContentId = contentId;
  cancelResizeAsk();
  let entry = terminals.get(contentId);
  if (!entry) {
    entry = { view: makeView(contentId), phase: 'opening', endReason: null };
    terminals.set(contentId, entry);
  } else if (entry.phase === 'ended') {
    entry.phase = 'opening';
    entry.endReason = null;
  }
  showOnly(entry.view);
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
  const grid = currentTerminal().gridAt(newTabFont());
  ui.newTabRef = nextRef();
  ui.newTabWorktreeId = worktreeId;
  link.send({ t: 'tab.new', worktreeId, cols: grid?.cols, rows: grid?.rows, ref: ui.newTabRef });
  renderSessions();
}

/** ЗД11: `cols`/`rows` на първия таб — както при „Нов таб“ (ОП27); Mac-ът после взима своя размер. */
function newWorktree(d) {
  if (d.ref) return;
  const grid = currentTerminal().gridAt(newTabFont());
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
  const grid = currentTerminal().gridAt(newTabFont());
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
  on('refresh-button', 'click', refreshWorktrees);
  on('confirm-delete-cancel', 'click', () => { closeConfirmDelete(); terminalFocus.focus(); });
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
initSetupView({ onSave: (connectionKey) => link.send({ t: 'setup', connectionKey }), onClosed: () => terminalFocus.focus() });
initSuggestions({ link, terminal: terminalFocus });
wireControls();
toggleSidebar(readJson(SIDEBAR_KEY, false) === true);
render();
