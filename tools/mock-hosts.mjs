// Mac-овете на mock relay-а (раздел „Multiple hosts“ в протокола) и списъкът им, както го праща relay-ят.

import { LEGACY_HOST, SINGLE_HOST } from './mock-config.mjs';
import { homeRepos, officeRepos, rowIds, sections } from './mock-data.mjs';

/** Един Mac на mock relay-а. `lan` — само той предлага LAN; `rowIds`/`sections` — sidebar-ът му. */
function makeHost({ id, name, online, repos: hostRepos, lan = false, rowIds: hostRowIds, sections: hostSections }) {
  return {
    id, name, originalName: name, online, repos: hostRepos, sessions: new Map(), lan, layouts: new Map(),
    rowIds: hostRowIds, sections: hostSections,
    knownContent: new Set(hostRepos.flatMap((r) => r.worktrees.flatMap((w) => w.tabs.map((t) => t.contentId)))),
  };
}

/** hostId → Mac. Id-тата приличат на истинските (16 hex), за да се видят в лога. */
export const hosts = new Map();
const office = { id: '0f1ce0ff1ce0ff1c', online: true, repos: officeRepos, lan: true, rowIds, sections };
for (const h of SINGLE_HOST ? [makeHost({ ...office, name: 'Mock Mac' })] : [
  makeHost({ ...office, name: 'Office Mac' }),
  makeHost({ id: '40be40be40be40be', name: 'Home Mac', online: true, repos: homeRepos }),
  makeHost({ id: '3a1a3a1a3a1a3a1a', name: 'Mac mini', online: false, repos: [] }),
]) hosts.set(h.id, h);
if (LEGACY_HOST) {
  // Стар Supacode: без име и без hostId, relay-ят го води `default`. Дълбоко копие: `tab.new`
  // добавя в масива с табове, а общ масив би показал новия таб и в „Home Mac“.
  const legacyRepos = structuredClone(homeRepos).map(({ canCreateWorktree, ...r }) => ({ ...r, id: 'legacy-' + r.id }));
  hosts.set('default', makeHost({ id: 'default', online: true, repos: legacyRepos }));
}
export const officeHost = hosts.get('0f1ce0ff1ce0ff1c');

/** Списъкът, както го подрежда relay-ят: по име без значение на главни букви, без име накрая, после по id. */
export function hostList() {
  return [...hosts.values()]
    .map((h) => ({ id: h.id, ...(h.name ? { name: h.name } : {}), online: h.online }))
    .sort((a, b) => {
      if (!a.name !== !b.name) return a.name ? -1 : 1;
      const byName = (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase());
      return byName || a.id.localeCompare(b.id);
    });
}
