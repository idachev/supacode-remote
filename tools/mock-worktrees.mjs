// Worktree-тата на Mac-а: `worktree.new` (ЗД11), `worktree.delete` и `worktrees.refresh` (ЗД13).

import { UNKNOWN_TYPE, send } from './mock-clients.mjs';
import { sendList } from './mock-list.mjs';
import { log } from './mock-log.mjs';
import { clamp, stopSession } from './mock-sessions.mjs';
import { createTab } from './mock-tabs.mjs';

/** Заявките `worktree.new`, които още чакат: repository + име с малки букви (`worktree_busy`). */
const creatingWorktrees = new Set();

function worktreeError(c, msg, code, message) {
  log('worktree.new failed', { code, client: c.id });
  send(c, { t: 'error', id: msg.id ?? null, message, code });
}

/** Проверките, които Mac-ът прави, преди да пусне git. `null` — може. */
function worktreeRequestError(host, msg) {
  if (typeof msg.repositoryId !== 'string') return ['worktree_invalid', 'worktree.new needs a repositoryId'];
  const repo = host.repos.find((r) => r.id === msg.repositoryId);
  if (!repo) return ['worktree_invalid', 'no such repository'];
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  if (!name) return ['worktree_invalid', 'worktree.new needs a branch name'];
  if (Buffer.byteLength(name) > 200) return ['worktree_invalid', 'the branch name is too long'];
  if (repo.canCreateWorktree !== true) return ['worktree_unsupported', 'worktrees are only supported for git repositories'];
  return null;
}

/** Нов worktree като бутона на Supacode: името е branch-ът, а първият таб се отваря сам. */
export function newWorktree(c, host, msg) {
  // Стар Supacode (MOCK_LEGACY) не познава съобщението — точно като истинския router.
  if (host.id === 'default') return send(c, { t: 'error', id: msg.id ?? null, message: 'unknown message type: worktree.new' });
  const problem = worktreeRequestError(host, msg);
  if (problem) return worktreeError(c, msg, ...problem);
  const repo = host.repos.find((r) => r.id === msg.repositoryId);
  const name = msg.name.trim();
  const key = `${host.id}/${repo.id}/${name.toLowerCase()}`;
  if (creatingWorktrees.has(key)) return worktreeError(c, msg, 'worktree_busy', 'a worktree with this branch is already being created');
  creatingWorktrees.add(key);
  const delay = name.startsWith('mock-slow') ? 6_000 : name.startsWith('mock-timeout') ? 3_000 : 1_000;
  log('worktree.new started', { host: host.id, repo: repo.id, name, client: c.id });
  setTimeout(() => {
    creatingWorktrees.delete(key);
    finishWorktree(c, host, repo, name, msg);
  }, delay);
}

function finishWorktree(c, host, repo, name, msg) {
  const lower = name.toLowerCase();
  if (repo.worktrees.some((w) => w.name.toLowerCase() === lower || w.branch?.toLowerCase() === lower)) {
    return worktreeError(c, msg, 'worktree_failed', 'Branch name already exists: Choose a different branch name and try again.');
  }
  if (name.startsWith('mock-fail')) return worktreeError(c, msg, 'worktree_failed', 'Unable to create worktree: fatal: mock git failure');
  if (name.startsWith('mock-timeout')) {
    return worktreeError(c, msg, 'worktree_timeout', 'worktree creation is still running on the Mac; it will appear in the list when it finishes');
  }
  const worktree = { id: `/mock/${repo.name}/${name}`, name, branch: name, status: 'unpinned', focused: true, working: false, tabs: [] };
  repo.worktrees.push(worktree);
  // Иначе списъкът по секции не го показва: под repository-то стоят само id-тата от `rowIds`.
  if (host.rowIds?.[repo.id]) host.rowIds[repo.id].push(worktree.id);
  const reply = { t: 'worktree.new', id: msg.id ?? null, repositoryId: repo.id, worktreeId: worktree.id, name };
  if (!name.startsWith('mock-notab')) {
    const sized = Number.isInteger(msg.cols) && Number.isInteger(msg.rows);
    const size = sized ? { cols: clamp(msg.cols, 20, 500), rows: clamp(msg.rows, 5, 200) } : {};
    Object.assign(reply, createTab(host, worktree, { ...size, focused: true }));
  }
  log('worktree.new created', { host: host.id, repo: repo.id, name, content: reply.contentId ?? null, client: c.id });
  send(c, reply);
}

/** Проверките преди изтриване (ЗД13): `[code, message]` или `null`. */
function deleteRequestError(host, msg) {
  if (typeof msg.worktreeId !== 'string' || !msg.worktreeId) return ['worktree_invalid', 'worktree.delete needs a worktreeId'];
  const repo = host.repos.find((r) => r.worktrees.some((w) => w.id === msg.worktreeId));
  if (!repo) return ['worktree_invalid', 'no such worktree'];
  const worktree = repo.worktrees.find((w) => w.id === msg.worktreeId);
  if (worktree.status === 'main') return ['worktree_unsupported', 'the main worktree cannot be deleted'];
  if (repo.canCreateWorktree !== true) return ['worktree_unsupported', 'folders cannot be deleted from the remote'];
  if (host.deletingWorktrees?.has(worktree.id)) return ['worktree_busy', 'the worktree is busy (being created, archived or deleted)'];
  if (worktree.name.includes('dirty')) {
    return ['worktree_dirty', 'the worktree has uncommitted changes or untracked files (2): notes.txt, src/app.js; commit, stash or remove them on the Mac first'];
  }
  return null;
}

/**
 * Изтрива worktree като Mac-а, без branch-а: след 1 s (`mock-slow…` — 6 s) го маха от списъка,
 * от `rowIds` и от секциите, а shell-овете на табовете му свършват (`detached` към закачените).
 * Име с `dirty` дава `worktree_dirty`; `mock-fail…` — `worktree_failed`.
 */
export function deleteWorktree(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  const problem = deleteRequestError(host, msg);
  if (problem) return worktreeError(c, msg, ...problem);
  const repo = host.repos.find((r) => r.worktrees.some((w) => w.id === msg.worktreeId));
  const worktree = repo.worktrees.find((w) => w.id === msg.worktreeId);
  host.deletingWorktrees ??= new Set();
  host.deletingWorktrees.add(worktree.id);
  log('worktree.delete started', { host: host.id, worktree: worktree.id, client: c.id });
  setTimeout(() => {
    host.deletingWorktrees.delete(worktree.id);
    if (worktree.name.startsWith('mock-fail')) {
      return worktreeError(c, msg, 'worktree_failed', 'Unable to delete worktree: fatal: mock git failure');
    }
    repo.worktrees.splice(repo.worktrees.indexOf(worktree), 1);
    for (const ids of Object.values(host.rowIds ?? {})) if (ids.includes(worktree.id)) ids.splice(ids.indexOf(worktree.id), 1);
    for (const section of host.sections ?? []) {
      if (section.worktreeIds?.includes(worktree.id)) section.worktreeIds.splice(section.worktreeIds.indexOf(worktree.id), 1);
    }
    for (const tab of worktree.tabs) stopSession(host, tab.contentId);
    log('worktree.delete done', { host: host.id, worktree: worktree.id, client: c.id });
    send(c, { t: 'worktree.delete', id: msg.id ?? null, worktreeId: worktree.id, repositoryId: repo.id });
  }, worktree.name.startsWith('mock-slow') ? 6_000 : 1_000);
}

/** Mac-ът чете worktree-тата наново: след 0,5 s пълен `list` със същото id (`mock-refresh-timeout` — грешка). */
export function refreshWorktrees(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  setTimeout(() => {
    if (host.refreshTimeout) {
      return worktreeError(c, msg, 'refresh_timeout', 'the refresh is still running on the Mac; send list again later');
    }
    log('worktrees.refresh done', { host: host.id, client: c.id });
    sendList(c, host, msg.id ?? null);
  }, 500);
}
