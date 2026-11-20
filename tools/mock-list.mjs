// `list` на Mac-а, както го праща новият и старият host, и `watch`: `list` с `id:null` при промяна.

import { UNKNOWN_TYPE, clients, send } from './mock-clients.mjs';
import { WITH_SECTIONS } from './mock-config.mjs';
import { hosts } from './mock-hosts.mjs';
import { layoutMessage, syncLayout } from './mock-layout.mjs';
import { log } from './mock-log.mjs';

/** `watch`: най-много един `list` на толкова ms на връзка. */
const WATCH_INTERVAL_MS = 250;

/**
 * ЗД13: какво може новият host — изтриване на всеки worktree освен основния и такива, които се
 * трият сега, „Опресни“ и repository-тата, които „не се четат“. Старият host (`default`) не праща нищо.
 */
function withDeleteFlags(host, repo) {
  if (host.id === 'default') return repo;
  const deletable = (w) => repo.canCreateWorktree === true && w.status !== 'main' && !host.deletingWorktrees?.has(w.id);
  return { ...repo, worktrees: repo.worktrees.map((w) => ({ ...w, canDeleteWorktree: deletable(w) })) };
}

/**
 * `busy` на всеки таб (КЛ13, 974aeeb1 във fork-а): затварянето би прекъснало програма. Mock-ът не
 * следи процесите в shell-а: зает е таб с агент или `working`, чист shell — не. Старият host го изпуска.
 */
function withBusyTabs(host, repo) {
  if (host.id === 'default') return repo;
  const busy = (tab) => tab.agents.length > 0 || tab.working === true;
  return { ...repo, worktrees: repo.worktrees.map((w) => ({ ...w, tabs: w.tabs.map((tab) => ({ ...tab, busy: busy(tab) })) })) };
}

/** Състоянието на split-овете на worktree-то, съгласувано с табовете му (или `null` без табове). */
export function layoutOf(host, worktree) {
  const state = syncLayout(host.layouts.get(worktree.id), worktree.tabs);
  if (state) host.layouts.set(worktree.id, state);
  else host.layouts.delete(worktree.id);
  return state;
}

/** Всеки worktree с табове получава `layout`; старият host не знае за него. */
function withLayouts(host, repo) {
  if (host.id === 'default') return repo;
  return {
    ...repo,
    worktrees: repo.worktrees.map((w) => {
      const state = layoutOf(host, w);
      return state ? { ...w, layout: layoutMessage(state) } : w;
    }),
  };
}

function listMessage(host, id) {
  const extra = host.id === 'default' ? {} : {
    canRefreshWorktrees: true,
    ...(host.loadFailure ? { loadFailures: [host.loadFailure] } : {}),
  };
  const repos = host.repos.map((r) => withLayouts(host, withBusyTabs(host, withDeleteFlags(host, r))));
  if (!WITH_SECTIONS || !host.sections) return { t: 'list', id, repos, ...extra };
  return { t: 'list', id, repos: repos.map((r) => ({ ...r, rowIds: host.rowIds[r.id] })), sections: host.sections, ...extra };
}

// ---- watch ----

/** Ключът на снимката: `list` без `id`, за да се види дали има промяна. */
const snapshotKey = (list) => JSON.stringify({ ...list, id: null });

/** `list` към клиента; запомня снимката, с която `watch` сравнява. */
export function sendList(c, host, id) {
  const list = listMessage(host, id);
  c.lastListKey = snapshotKey(list);
  send(c, list);
}

let watchTimer = null;

/**
 * Проверка на 250 ms, само докато някой гледа (host-ът не работи нищо без watch): при разлика от
 * последния изпратен `list` — нов `list` с `id:null`. Така и последното състояние винаги стига.
 */
function watchTick() {
  const watchers = [...clients].filter((c) => c.watching);
  if (watchers.length === 0) {
    clearInterval(watchTimer);
    watchTimer = null;
    return;
  }
  for (const c of watchers) {
    const host = hosts.get(c.hostId);
    if (!host || (!host.online && !c.lan)) continue;
    if (snapshotKey(listMessage(host, null)) !== c.lastListKey) sendList(c, host, null);
  }
}

export function watch(c, host, msg) {
  if (host.id === 'default') return UNKNOWN_TYPE(c, msg);
  // `on` е незадължително: без него `watch` пуска гледането (протоколът, „watch“).
  c.watching = msg.on !== false;
  log('watch', { host: host.id, client: c.id, on: c.watching });
  send(c, { t: 'watch', id: msg.id ?? null, on: c.watching });
  if (c.watching && !watchTimer) watchTimer = setInterval(watchTick, WATCH_INTERVAL_MS);
  return undefined;
}
