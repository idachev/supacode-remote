// Заявките за worktree-тата към Mac-а: „Нов worktree“ (ЗД11), изтриване и „Опресни“ (ЗД13).
// Полето и подсказките на „Нов worktree“ са в worktree-dialog.js; тук са заявките, чакането им и
// какво вижда потребителят, когато отговорът дойде, не дойде или е грешка.

import { $, toast } from './dom.js';
import { renderSessions } from './sessions-view.js';
import { currentTab, nextRef, ui } from './ui-state.js';
import { closeWorktreeDialog, renderWorktreeDialog } from './worktree-dialog.js';

/** Отговорът на `worktree.new` не дойде: таймаут или паднала връзка (К2, К3). */
const WORKTREE_UNKNOWN = 'Mac-ът още създава worktree-то или връзката падна, затова не знам как е свършило. Worktree-то може да се появи в списъка по-късно. Можеш да опиташ пак със същото име.';
/** К7, К8: изтриването може още да тече, а отговорът не дойде. */
const DELETE_UNKNOWN = 'Mac-ът още изтрива worktree-то или връзката падна. Worktree-то може да изчезне от списъка по-късно.';
const REFRESH_LATER = 'Mac-ът още чете worktree-тата; опитай пак по-късно.';
/** Тези кодове значат „отговорът няма да дойде“, а не „Mac-ът отказа“. */
const WORKTREE_UNKNOWN_CODES = ['worktree_timeout', 'worktree_lost'];

/** `link`, `openTab`, `closeOpenTab`, `toastWithApp`, `newTabGrid` и `focusTerminal` идват от app.js. */
let deps = null;

export function initWorktreeRequests(given) {
  deps = given;
  const on = (id, event, handler) => $(id).addEventListener(event, handler);
  on('refresh-button', 'click', refreshWorktrees);
  on('confirm-delete-cancel', 'click', () => { closeConfirmDelete(); deps.focusTerminal(); });
  on('confirm-delete-ok', 'click', confirmDeleteWorktree);
  on('confirm-delete', 'keydown', (e) => { if (e.key === 'Escape') closeConfirmDelete(); });
}

// ---- „Нов worktree“ (ЗД11) ----

/** `cols`/`rows` на първия таб — както при „Нов таб“ (ОП27); Mac-ът после взима своя размер. */
export function newWorktree(d) {
  if (d.ref) return;
  const grid = deps.newTabGrid();
  const ref = nextRef();
  if (!deps.link.send({ t: 'worktree.new', repositoryId: d.repositoryId, name: d.name.trim(), cols: grid?.cols, rows: grid?.rows, ref })) {
    d.error = 'Няма връзка — не е изпратено';
    renderWorktreeDialog();
    return;
  }
  d.ref = ref;
  d.error = null;
  renderWorktreeDialog();
  renderSessions();
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
  if (m.contentId) deps.openTab(m.contentId);
  else toast(`Worktree-то „${m.name}“ е създадено, но първият му таб не се отвори. Отвори „+ Нов таб“ под него.`);
  renderSessions();
}

/** `worktree_timeout` носи английски текст от Mac-а; на потребителя се казва на български. */
export function worktreeErrorText(m) {
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

export function askDeleteWorktree(worktree, repositoryName) {
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
  if (!deps.link.send({ t: 'worktree.delete', worktreeId: ask.worktreeId, ref })) {
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
  if (d.openInside && d.openInside === ui.openContentId) deps.closeOpenTab();
  renderSessions();
}

function onDeleteError(d, m) {
  ui.deleting.delete(d.worktreeId);
  const lost = WORKTREE_UNKNOWN_CODES.includes(m.code);
  // `worktree_dirty` изброява файловете: стои по-дълго, за да се прочете.
  deps.toastWithApp(lost ? DELETE_UNKNOWN : `Не изтрих „${d.name}“: ${m.message || 'грешка от Mac-а'}`, m.code === 'worktree_dirty' ? 12_000 : undefined);
  renderSessions();
}

function refreshWorktrees() {
  if (ui.refreshRef || !ui.list?.canRefreshWorktrees) return;
  const ref = nextRef();
  if (!deps.link.send({ t: 'worktrees.refresh', ref })) {
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

function onRefreshError(m) {
  onRefreshDone(m);
  deps.toastWithApp(WORKTREE_UNKNOWN_CODES.includes(m.code) || m.code === 'refresh_timeout'
    ? REFRESH_LATER : `Не опресних: ${m.message || 'грешка от Mac-а'}`);
}

export function renderRefresh() {
  const button = $('refresh-button');
  button.hidden = ui.list?.canRefreshWorktrees !== true;
  button.disabled = ui.refreshRef != null || ui.state?.hostSession == null;
}

// ---- отговорите от Node ----

/** Отговорите на заявките за worktree-та, по типа на съобщението. */
export const WORKTREE_REPLIES = {
  'worktree.new': onWorktreeNew,
  'worktree.delete': onWorktreeDelete,
  'worktrees.refresh': onRefreshDone,
};

/** Грешка за чакаща заявка за worktree се показва при нея; `true`, ако е била такава. */
export function handleWorktreeError(m) {
  if (m.ref && m.ref === ui.newWorktree?.ref) {
    onWorktreeError(m);
    return true;
  }
  const deleting = deletingFor(m.ref);
  if (deleting) {
    onDeleteError(deleting, m);
    return true;
  }
  if (!m.ref || m.ref !== ui.refreshRef) return false;
  onRefreshError(m);
  return true;
}

/** Отговорите на чакащите заявки няма да дойдат (паднала връзка, друга страница, нов Mac). */
export function dropWorktreeRequests() {
  if (ui.newWorktree?.ref) onWorktreeError({ code: 'worktree_lost' });
  if (ui.deleting.size) toast(DELETE_UNKNOWN);
  ui.deleting.clear();
  ui.refreshRef = null;
  closeConfirmDelete();
  renderRefresh();
}
