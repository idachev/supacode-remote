// Изборът на отдалечен таб за `attach`: от `list` на Mac-а към номериран списък и търсене по
// аргумента от командния ред. `list` минава почти непроверен от протокола, затова тук всяко
// поле се проверява: счупен таб се прескача, а не чупи списъка.

const arr = (v) => (Array.isArray(v) ? v : []);
const text = (v, fallback) => (typeof v === 'string' && v ? v : fallback);

/** Табовете в реда на страничната лента на Mac-а, с етикет „repo / worktree / заглавие“. */
export function listTabs(list) {
  return arr(list?.repos).flatMap((repo) => arr(repo?.worktrees).flatMap((worktree) => worktreeTabs(repo, worktree)));
}

/** Табовете на едно worktree; таб без `contentId` не може да се закачи и се прескача. */
function worktreeTabs(repo, worktree) {
  return arr(worktree?.tabs)
    .filter((tab) => typeof tab?.contentId === 'string')
    .map((tab) => ({ contentId: tab.contentId, label: [text(repo.name, '?'), text(worktree.name, '?'), text(tab.title, 'таб')].join(' / ') }));
}

/** Точно `contentId`, иначе единственият таб, чийто етикет съдържа текста. */
export function findTab(tabs, query) {
  const exact = tabs.find((t) => t.contentId === query);
  if (exact) return { tab: exact };
  const needle = String(query).toLowerCase();
  const matches = tabs.filter((t) => t.label.toLowerCase().includes(needle));
  if (matches.length === 1) return { tab: matches[0] };
  if (matches.length === 0) return { error: `Няма таб „${query}“` };
  return { error: `„${query}“ съвпада с ${matches.length} таба` };
}
