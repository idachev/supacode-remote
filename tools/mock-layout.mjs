// Минималният модел на split-овете в mock-а (`layout` в `list`, `pane.split`, `pane.close`,
// `tab.new paneId`; раздел „list“ в протокола на branch `remote-client-host`).
//
// Само `tabsPerSplit` с една група `main`, без zoom. Pane-овете са плосък списък в реда на
// създаване; всеки помни посоката, с която е отделен. Дървото се строи от този списък: първият
// pane, после за всеки следващ split отдясно с неговата посока. Това не е подредбата на истинския
// Mac, но е валидно дърво, а split и close наистина го сменят — достатъчно, за да се пробва
// клиентът без втори Mac (решение D2 на 3amigos, 2026-11-18).

let paneCounter = 0;

function newPaneId() {
  paneCounter += 1;
  return `pane-${paneCounter}`;
}

/**
 * Състоянието на worktree-то, съгласувано с табовете му: махнатите табове излизат от pane-овете,
 * празен pane изчезва, а нов таб без pane отива във фокусирания. Без табове — `null` (протоколът
 * изпуска `layout` тогава). Състоянието се мени на място и се връща.
 */
export function syncLayout(state, tabs) {
  const tabIds = tabs.map((t) => t.id);
  if (tabIds.length === 0) return null;
  const layout = state ?? { panes: [], focusedPaneId: null };
  const known = new Set(tabIds);
  for (const pane of layout.panes) pane.tabIds = pane.tabIds.filter((id) => known.has(id));
  layout.panes = layout.panes.filter((pane) => pane.tabIds.length > 0);
  const placed = new Set(layout.panes.flatMap((pane) => pane.tabIds));
  const loose = tabIds.filter((id) => !placed.has(id));
  if (loose.length > 0) {
    if (layout.panes.length === 0) layout.panes.push({ id: newPaneId(), tabIds: [], selectedTabId: null, direction: null });
    const target = layout.panes.find((pane) => pane.id === layout.focusedPaneId) ?? layout.panes[0];
    target.tabIds.push(...loose);
  }
  for (const pane of layout.panes) {
    if (!pane.tabIds.includes(pane.selectedTabId)) pane.selectedTabId = pane.tabIds[0];
  }
  if (!layout.panes.some((pane) => pane.id === layout.focusedPaneId)) layout.focusedPaneId = layout.panes[0].id;
  return layout;
}

/** `layout` за `list`, по формата от протокола. */
export function layoutMessage(state) {
  const [first, ...rest] = state.panes;
  const tree = rest.reduce(
    (left, pane) => ({ split: { direction: pane.direction, ratio: 0.5, left, right: { pane: pane.id } } }),
    { pane: first.id },
  );
  return {
    mode: 'tabsPerSplit',
    activeGroupId: 'main',
    groups: [{ id: 'main', focusedPaneId: state.focusedPaneId, tree }],
    panes: state.panes.map((pane) => ({ id: pane.id, tabIds: [...pane.tabIds], selectedTabId: pane.selectedTabId })),
  };
}

/** Нов pane с таба `tabId` веднага след `paneId`; той става фокусираният. Връща id-то му. */
export function splitPane(state, paneId, direction, tabId) {
  const index = state.panes.findIndex((pane) => pane.id === paneId);
  const pane = { id: newPaneId(), tabIds: [tabId], selectedTabId: tabId, direction };
  state.panes.splice(index + 1, 0, pane);
  state.focusedPaneId = pane.id;
  return pane.id;
}

/** Таб, отворен с `tab.new paneId`: отива в този pane и е избран там. */
export function addTabToPane(state, paneId, tabId) {
  const pane = state.panes.find((p) => p.id === paneId);
  for (const other of state.panes) other.tabIds = other.tabIds.filter((id) => id !== tabId);
  pane.tabIds.push(tabId);
  pane.selectedTabId = tabId;
  state.panes = state.panes.filter((p) => p.tabIds.length > 0);
}
