// Редовете на списъка „Сесии“ от `list` (пренесено от Android `SessionGroups.kt`).
//
// С `sections` списъкът е точно sidebar-ът на Supacode (Active, Pinned, групи, repository-та
// по `rowIds`); без тях (стар host) — групиране по `status` във всеки repository. Непознат
// `kind` или `status` не чупи списъка: първият се прескача, вторият отива в „Активни“.

import { fuzzyMatches } from './fuzzy-match.js';

const STATUSES = ['main', 'pinned', 'unpinned'];

export function worktreeStatus(wire) {
  return STATUSES.includes(wire) ? wire : 'unpinned';
}

/** Собственото заглавие от Supacode, иначе името на worktree-то. */
export function displayName(worktree) {
  const title = typeof worktree.title === 'string' ? worktree.title.trim() : '';
  return title || worktree.name;
}

function worktreeMatches(wt, q) {
  return [displayName(wt), wt.name, wt.branch].filter(Boolean).some((s) => fuzzyMatches(s, q));
}

/**
 * Намерено име на repository-то оставя всичките му worktree-та; иначе остават само
 * worktree-тата с намерено име, заглавие или branch, а repository без тях отпада.
 */
export function filterRepos(repos, query) {
  const q = String(query ?? '').trim();
  if (!q) return repos;
  return repos.flatMap((repo) => {
    if (fuzzyMatches(repo.name, q)) return [repo];
    const found = (repo.worktrees ?? []).filter((wt) => worktreeMatches(wt, q));
    return found.length ? [{ ...repo, worktrees: found }] : [];
  });
}

function repoRows(repo) {
  const worktrees = repo.worktrees ?? [];
  if (!Array.isArray(repo.rowIds)) return worktrees;
  const byId = new Map(worktrees.map((w) => [w.id, w]));
  return repo.rowIds.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Плоският списък. `collapsed` е изборът в браузъра по id на група; група без избор взима
 * `collapsed` от Mac-а. При търсене всяка група с намерено е разгъната, а празните изчезват.
 *
 * Редове: `{kind:'section', id, sectionKind, title}`, `{kind:'group', id, title, collapsed}`,
 * `{kind:'repository', repository}`, `{kind:'status', repositoryId, status}`,
 * `{kind:'worktree', repositoryId, repositoryName, worktree, key}`.
 */
export function sessionRows(list, collapsed = {}, query = '') {
  const repos = Array.isArray(list?.repos) ? list.repos : [];
  const sections = Array.isArray(list?.sections) ? list.sections : [];
  const q = String(query ?? '').trim();
  return sections.length ? sectionRows({ repos, sections }, collapsed, q) : statusRows(repos, collapsed, q);
}

/** Общото за един списък: намереното, по id и чий е всеки worktree. */
function sectionContext(allRepos, collapsed, query) {
  const repos = filterRepos(allRepos, query);
  const owner = new Map();
  for (const r of repos) for (const w of r.worktrees ?? []) owner.set(w.id, r);
  return { query, searching: query.length > 0, collapsed, repoById: new Map(repos.map((r) => [r.id, r])), owner };
}

function sectionRows({ repos, sections }, collapsed, query) {
  const ctx = sectionContext(repos, collapsed, query);
  return sections.flatMap((section, index) => {
    const rowsOf = SECTION_ROWS[section?.kind];
    return rowsOf ? rowsOf(section, index, ctx) : [];
  });
}

/** При търсене repository-то остава само с ред за показване или с намерено име. */
function shownWhileSearching(repo, ctx) {
  return !ctx.searching || fuzzyMatches(repo.name, ctx.query) || repoRows(repo).length > 0;
}

function repositoryRows(repo, section) {
  return [{ kind: 'repository', repository: repo }, ...repoRows(repo).map((wt) => worktreeRow({ repo, worktree: wt, section }))];
}

/** Active / Pinned: worktree-та от всички repository-та, като „repo · worktree“. */
function liftedRows(section, index, ctx) {
  const id = `${index}:${section.kind}`;
  const items = (section.worktreeIds ?? []).flatMap((wtId) => {
    const repo = ctx.owner.get(wtId);
    const wt = repo?.worktrees.find((w) => w.id === wtId);
    return wt ? [worktreeRow({ repo, worktree: wt, section: id, repositoryName: repo.name })] : [];
  });
  if (!items.length) return [];
  const title = (section.title ?? '').trim() || (section.kind === 'active' ? 'Active' : 'Pinned');
  return [{ kind: 'section', id, sectionKind: section.kind, title }, ...items];
}

/** Група на sidebar-а; при търсене е разгъната, а без намерено изчезва. */
function groupRepos(section, ctx) {
  return (section.repositoryIds ?? []).map((rid) => ctx.repoById.get(rid)).filter((r) => r && shownWhileSearching(r, ctx));
}

function groupRows(section, index, ctx) {
  const id = `${index}:${section.title ?? ''}`;
  const repos = groupRepos(section, ctx);
  if (ctx.searching && repos.length === 0) return [];
  const collapsed = !ctx.searching && (ctx.collapsed[id] ?? section.collapsed === true);
  const header = { kind: 'group', id, title: (section.title ?? '').trim() || 'Група', collapsed };
  return collapsed ? [header] : [header, ...repos.flatMap((r) => repositoryRows(r, String(index)))];
}

function ungroupedRows(section, index, ctx) {
  const repo = ctx.repoById.get(section.repositoryId);
  return repo && shownWhileSearching(repo, ctx) ? repositoryRows(repo, String(index)) : [];
}

/** Редовете на всеки вид секция; непознат вид се прескача. */
const SECTION_ROWS = { active: liftedRows, pinned: liftedRows, group: groupRows, repository: ungroupedRows };

function worktreeRow({ repo, worktree, section = '', repositoryName = null }) {
  return { kind: 'worktree', repositoryId: repo.id, repositoryName, worktree, key: `wt:${section}:${repo.id}:${worktree.id}` };
}

/** Repository-тата по групата им на sidebar-а: първо без група, после всяка група по първа поява. */
function bySidebarGroup(repos) {
  const groupOf = (r) => (typeof r.group === 'string' && r.group.trim()) || null;
  const blocks = new Map();
  for (const r of repos) {
    const g = groupOf(r);
    if (!blocks.has(g)) blocks.set(g, []);
    blocks.get(g).push(r);
  }
  const ungrouped = blocks.get(null);
  blocks.delete(null);
  return [...(ungrouped ? [[null, ungrouped]] : []), ...blocks];
}

/** Repository без `sections`: основният веднага под името, после „Закачени“ и „Активни“. */
function statusRepositoryRows(repo) {
  const of = (status) => (repo.worktrees ?? []).filter((w) => worktreeStatus(w.status) === status);
  const rows = [{ kind: 'repository', repository: repo }, ...of('main').map((wt) => worktreeRow({ repo, worktree: wt }))];
  for (const status of ['pinned', 'unpinned']) {
    const list = of(status);
    if (list.length) rows.push({ kind: 'status', repositoryId: repo.id, status }, ...list.map((wt) => worktreeRow({ repo, worktree: wt })));
  }
  return rows;
}

/** Резервният списък без `sections`: групи по `group`, после основен / закачени / активни. */
function statusRows(allRepos, collapsed, query) {
  return bySidebarGroup(filterRepos(allRepos, query)).flatMap(([name, repos]) => {
    if (name === null) return repos.flatMap(statusRepositoryRows);
    const id = `group:${name}`;
    const isCollapsed = !query && (collapsed[id] ?? false);
    const header = { kind: 'group', id, title: name, collapsed: isCollapsed };
    return isCollapsed ? [header] : [header, ...repos.flatMap(statusRepositoryRows)];
  });
}

/** Всички worktree-та по реда на списъка, без повторения (за Ctrl+⌘+← / →). */
export function worktreeOrder(rows) {
  const seen = new Set();
  return rows.filter((r) => r.kind === 'worktree' && !seen.has(r.worktree.id) && seen.add(r.worktree.id));
}

/** Worktree-то и repository-то на таба с този `contentId`. */
export function findTab(list, contentId) {
  for (const repo of list?.repos ?? []) {
    const found = findTabIn(repo, contentId);
    if (found) return found;
  }
  return null;
}

function findTabIn(repo, contentId) {
  for (const wt of repo.worktrees ?? []) {
    const tab = (wt.tabs ?? []).find((t) => t.contentId === contentId);
    if (tab) return { repo, worktree: wt, tab };
  }
  return null;
}

/** Чака ли агент вход в този таб — най-ярката значка. */
export function isAwaiting(tab) {
  return (tab.agents ?? []).some((a) => a.activity === 'awaitingInput');
}

/** Колко таба чакат вход: броят е в заглавието на страницата. */
export function countAwaiting(list) {
  return (list?.repos ?? []).flatMap((r) => r.worktrees ?? []).flatMap((w) => w.tabs ?? []).filter(isAwaiting).length;
}

export const ACTIVITY_LABELS = {
  awaitingInput: 'чака вход',
  busy: 'работи',
  error: 'грешка',
  compacting: 'компактира',
  idle: 'свободен',
};

export function activityLabel(activity) {
  return ACTIVITY_LABELS[activity] ?? String(activity ?? '');
}
