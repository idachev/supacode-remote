// Колоната „Сесии“: редовете от `sessionRows`, разгънатите worktree-та с табовете им и „Нов таб“.

import { $, el, writeStorage } from './dom.js';
import { icon } from './icons.js';
import { activityLabel, displayName, isAwaiting, sessionRows } from './session-groups.js';
import { COLLAPSED_KEY, currentTab, ui } from './ui-state.js';

/** `openTab`, `newTab`, `newWorktree(repository)` и `deleteWorktree(worktree, repositoryName)` идват от app.js. */
let actions = { openTab() {}, newTab() {}, newWorktree() {}, deleteWorktree() {} };

export function initSessionsView(given) {
  actions = given;
}

function emptyText() {
  if (!ui.list) return ui.state?.hostSession != null ? 'Чакам списъка от Mac-а…' : 'Чакам връзка с Mac-а…';
  const q = ui.query.trim();
  return q ? `Нищо не отговаря на „${q}“` : 'Няма сесии.';
}

export function renderSessions() {
  const box = $('session-list');
  box.replaceChildren();
  const rows = ui.list ? sessionRows(ui.list, ui.collapsed, ui.query) : [];
  if (!rows.length) box.append(el('div', 'empty', emptyText()));
  const open = currentTab();
  for (const row of rows) box.append(...(ROW_VIEWS[row.kind]?.(row, open) ?? []));
  for (const failure of ui.list?.loadFailures ?? []) box.append(loadFailureRow(failure));
}

/** Repository, което Mac-ът не прочете (ЗД13): да не изглежда, че worktree-тата му са изтрити. */
function loadFailureRow(failure) {
  const id = String(failure?.repositoryId ?? '');
  const name = id.replace(/\/+$/, '').split('/').pop() || id;
  const node = el('div', 'row row-load-failure', `${name} не се чете на Mac-а: ${failure?.message ?? ''}`);
  node.title = id;
  return node;
}

function groupRow(row) {
  // Като в Android: линия отгоре, ▸ / ▾ и името с главни букви.
  const node = el('div', `row row-group${row.collapsed ? ' collapsed' : ''}`, row.title.toLocaleUpperCase('bg'));
  node.addEventListener('click', () => {
    ui.collapsed[row.id] = !row.collapsed;
    writeStorage(COLLAPSED_KEY, ui.collapsed);
    renderSessions();
  });
  return [node];
}

const ROW_VIEWS = {
  section: (row) => [el('div', 'row row-section', row.title)],
  group: groupRow,
  repository: (row) => [repositoryRow(row.repository)],
  status: (row) => [el('div', 'row row-status', row.status === 'pinned' ? 'Закачени' : 'Активни')],
  worktree: (row, open) => worktreeRows(row, open),
};

function repositoryRow(repository) {
  const node = el('div', 'row row-repo');
  node.append(icon('repository'), el('span', 'name', repository.name));
  // ЗД11: само щом Mac-ът каже, че може; стар host не праща `canCreateWorktree`.
  if (repository.canCreateWorktree === true) node.append(newWorktreeButton(repository));
  return node;
}

function newWorktreeButton(repository) {
  const button = el('button', 'repo-new', '+');
  button.type = 'button';
  button.title = `Нов worktree в ${repository.name}`;
  button.setAttribute('aria-label', button.title);
  button.disabled = ui.state?.hostSession == null || ui.newWorktree?.ref != null;
  button.addEventListener('click', () => actions.newWorktree(repository));
  return button;
}

function worktreeRows(row, open) {
  const header = worktreeHeader(row, open);
  return ui.expanded.has(row.worktree.id) ? [header, tabList(row.worktree)] : [header];
}

/** Точката пред worktree-то: агент чака вход (най-ярката), нещо работи, или нищо. */
function dotClass(wt) {
  if ((wt.tabs ?? []).some(isAwaiting)) return 'dot awaiting';
  return wt.working ? 'dot working' : 'dot';
}

function worktreeHeader(row, open) {
  const wt = row.worktree;
  const node = el('div', `row row-wt${open?.worktree.id === wt.id ? ' current' : ''}`);
  node.append(icon('open', ui.expanded.has(wt.id) ? 'expanded' : ''), icon('worktree'), el('span', dotClass(wt)));
  const label = row.repositoryName ? `${row.repositoryName} · ${displayName(wt)}` : displayName(wt);
  node.append(el('span', 'name', label));
  if (wt.status === 'main' && !row.repositoryName) node.append(el('span', 'badge', 'Основен'));
  if (wt.branch && wt.branch !== wt.name) node.append(el('span', 'branch', wt.branch));
  node.title = wt.branch ? `${label} — ${wt.branch}` : label;
  node.addEventListener('click', () => toggleExpanded(wt.id));
  if (ui.deleting.has(wt.id)) node.append(el('span', 'deleting', 'Изтривам…'));
  else if (wt.canDeleteWorktree === true) node.append(deleteButton(row));
  return node;
}

/** ЗД13: само щом Mac-ът каже `canDeleteWorktree`; стар host не го праща. */
function deleteButton(row) {
  const button = el('button', 'wt-delete', '🗑');
  button.type = 'button';
  button.title = 'Изтрий worktree';
  button.setAttribute('aria-label', button.title);
  button.disabled = ui.state?.hostSession == null;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const repo = (ui.list?.repos ?? []).find((r) => r.id === row.repositoryId);
    actions.deleteWorktree(row.worktree, repo?.name ?? row.repositoryName ?? '');
  });
  return button;
}

function toggleExpanded(worktreeId) {
  if (!ui.expanded.delete(worktreeId)) ui.expanded.add(worktreeId);
  renderSessions();
}

function tabList(wt) {
  const box = el('div', 'tabs');
  for (const tab of wt.tabs ?? []) box.append(tabRow(tab));
  box.append(newTabButton(wt));
  return box;
}

function tabRow(tab) {
  const node = el('div', `tab${tab.contentId === ui.openContentId ? ' open' : ''}`);
  node.append(el('span', 'name', tab.title || 'Таб'));
  for (const a of tab.agents ?? []) node.append(el('span', `badge ${a.activity}`, `${a.agent} · ${activityLabel(a.activity)}`));
  if (tab.readOnly) node.append(el('span', 'badge', 'само четене'));
  node.addEventListener('click', () => actions.openTab(tab.contentId));
  return node;
}

function newTabButton(wt) {
  const pending = ui.newTabWorktreeId === wt.id;
  const button = el('button', 'new-tab', pending ? 'Отварям нов таб…' : '+ Нов таб');
  button.type = 'button';
  button.title = 'Нов таб в този worktree';
  button.disabled = pending || ui.state?.hostSession == null;
  button.addEventListener('click', () => actions.newTab(wt.id));
  return button;
}
