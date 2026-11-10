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
  return sections.length ? sectionRows(repos, sections, collapsed, q) : statusRows(repos, collapsed, q);
}

function sectionRows(allRepos, sections, collapsed, query) {
  const searching = query.length > 0;
  const repos = filterRepos(allRepos, query);
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const owner = new Map();
  for (const r of repos) for (const w of r.worktrees ?? []) owner.set(w.id, r);
  const shownWhileSearching = (repo) => fuzzyMatches(repo.name, query) || repoRows(repo).length > 0;
  const rows = [];
  const addRepository = (repo, section) => {
    rows.push({ kind: 'repository', repository: repo });
    for (const wt of repoRows(repo)) rows.push(worktreeRow(repo, wt, section, null));
  };
  sections.forEach((section, index) => {
    switch (section?.kind) {
      case 'active':
      case 'pinned': {
        const id = `${index}:${section.kind}`;
        const items = (section.worktreeIds ?? []).flatMap((wtId) => {
          const repo = owner.get(wtId);
          const wt = repo?.worktrees.find((w) => w.id === wtId);
          return wt ? [worktreeRow(repo, wt, id, repo.name)] : [];
        });
        if (items.length) {
          const title = (section.title ?? '').trim() || (section.kind === 'active' ? 'Active' : 'Pinned');
          rows.push({ kind: 'section', id, sectionKind: section.kind, title });
          rows.push(...items);
        }
        break;
      }
      case 'group': {
        const id = `${index}:${section.title ?? ''}`;
        const groupRepos = (section.repositoryIds ?? []).map((rid) => repoById.get(rid)).filter(Boolean)
          .filter((r) => !searching || shownWhileSearching(r));
        if (searching && groupRepos.length === 0) break;
        const isCollapsed = !searching && (collapsed[id] ?? section.collapsed === true);
        rows.push({ kind: 'group', id, title: (section.title ?? '').trim() || 'Група', collapsed: isCollapsed });
        if (!isCollapsed) groupRepos.forEach((r) => addRepository(r, String(index)));
        break;
      }
      case 'repository': {
        const repo = repoById.get(section.repositoryId);
        if (repo && (!searching || shownWhileSearching(repo))) addRepository(repo, String(index));
        break;
      }
      default:
        break;
    }
  });
  return rows;
}

function worktreeRow(repo, worktree, section, repositoryName) {
  return {
    kind: 'worktree', repositoryId: repo.id, repositoryName, worktree,
    key: `wt:${section ?? ''}:${repo.id}:${worktree.id}`,
  };
}

/** Резервният списък без `sections`: групи по `group`, после основен / закачени / активни. */
function statusRows(allRepos, collapsed, query) {
  const repos = filterRepos(allRepos, query);
  const groupOf = (r) => (typeof r.group === 'string' && r.group.trim()) || null;
  const order = [];
  const byGroup = new Map();
  const ungrouped = repos.filter((r) => !groupOf(r));
  for (const r of repos.filter(groupOf)) {
    const g = groupOf(r);
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      order.push(g);
    }
    byGroup.get(g).push(r);
  }
  const blocks = [];
  if (ungrouped.length) blocks.push([null, ungrouped]);
  for (const g of order) blocks.push([g, byGroup.get(g)]);
  const rows = [];
  for (const [name, groupRepos] of blocks) {
    if (name !== null) {
      const id = `group:${name}`;
      const isCollapsed = !query && (collapsed[id] ?? false);
      rows.push({ kind: 'group', id, title: name, collapsed: isCollapsed });
      if (isCollapsed) continue;
    }
    for (const repo of groupRepos) {
      rows.push({ kind: 'repository', repository: repo });
      const of = (s) => (repo.worktrees ?? []).filter((w) => worktreeStatus(w.status) === s);
      for (const wt of of('main')) rows.push(worktreeRow(repo, wt, '', null));
      for (const status of ['pinned', 'unpinned']) {
        const list = of(status);
        if (!list.length) continue;
        rows.push({ kind: 'status', repositoryId: repo.id, status });
        for (const wt of list) rows.push(worktreeRow(repo, wt, '', null));
      }
    }
  }
  return rows;
}

/** Всички worktree-та по реда на списъка, без повторения (за Ctrl+⌘+← / →). */
export function worktreeOrder(rows) {
  const seen = new Set();
  return rows.filter((r) => r.kind === 'worktree' && !seen.has(r.worktree.id) && seen.add(r.worktree.id));
}

/** Worktree-то и repository-то на таба с този `contentId`. */
export function findTab(list, contentId) {
  for (const repo of list?.repos ?? []) {
    for (const wt of repo.worktrees ?? []) {
      const tab = (wt.tabs ?? []).find((t) => t.contentId === contentId);
      if (tab) return { repo, worktree: wt, tab };
    }
  }
  return null;
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
