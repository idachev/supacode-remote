// Живите терминали на страницата (ДЗ23).
//
// По един `TerminalView` за всеки терминал от набора на Node: скритите са в същия контейнер и пак
// пишат изхода си, затова връщането към таба е без мрежа и със същия скрол. Node казва с
// `released`, кога терминал излиза от набора. `blank` е празният терминал без отворен таб: по него
// се мери мястото за нов таб.

import { $ } from './dom.js';
import { TerminalView } from './terminal.js';
import { ui } from './ui-state.js';

/** contentId → `{view, phase, endReason}`; `phase` е като `ui.phase`, но за този терминал. */
const terminals = new Map();
/** `link` и `copyText` идват от app.js. */
let deps = null;
let blank = null;

export function initLiveTerminals(given) {
  deps = given;
  blank = makeView(null);
}

function makeView(contentId) {
  const box = document.createElement('div');
  box.className = 'term-view';
  if (contentId) box.dataset.contentId = contentId;
  $('term').append(box);
  return new TerminalView(box, $('term-area'), {
    // Вход само от видимия таб (АЦ1): скрит терминал не бива да пише в своя PTY.
    onInput: (b64) => {
      if (contentId && contentId === ui.openContentId && ui.phase === 'live') deps.link.send({ t: 'input', b64, contentId });
    },
    // УА4: маркираното в Claude Code (OSC 52) идва тук, не само в clipboard-а на Mac-а; от скрит таб — не.
    onClipboard: (text) => {
      if (contentId === ui.openContentId) deps.copyText(text);
    },
  });
}

/** Терминалът пред очите: на отворения таб или празният. */
export function currentTerminal() {
  return terminals.get(ui.openContentId)?.view ?? blank;
}

function showOnly(view) {
  blank.show(blank === view);
  for (const entry of terminals.values()) entry.view.show(entry.view === view);
}

/** Без отворен таб: само празният терминал. */
export function showBlank() {
  showOnly(blank);
}

/** `ui.phase` е фазата на видимия терминал. */
export function syncPhase() {
  const entry = terminals.get(ui.openContentId);
  ui.phase = entry ? entry.phase : 'none';
  ui.endReason = entry?.endReason ?? null;
}

export function disposeTerminals() {
  for (const entry of terminals.values()) entry.view.dispose();
  terminals.clear();
  blank.clear();
  showOnly(blank);
}

/**
 * Терминалът на таба, показан сам. Нов чака `attach`; затворен (`detached`) таб тръгва отначало:
 * „Свържи отново“.
 */
export function showTerminal(contentId) {
  let entry = terminals.get(contentId);
  if (!entry) {
    entry = { view: makeView(contentId), phase: 'opening', endReason: null };
    terminals.set(contentId, entry);
  } else if (entry.phase === 'ended') {
    entry.phase = 'opening';
    entry.endReason = null;
  }
  showOnly(entry.view);
  return entry;
}

/** Node пусна терминала: xterm.js му се маха. `false`, ако страницата не го е имала. */
export function releaseTerminal(contentId) {
  const entry = terminals.get(contentId);
  if (!entry) return false;
  entry.view.dispose();
  terminals.delete(contentId);
  return true;
}

/**
 * Нова сесия с Mac-а: той е забравил attach-овете. Node закача видимия веднага (без сесия —
 * щом се върне), а скритите — когато се покажат; дотогава те не са „на живо“.
 */
export function markReattach(hostSession) {
  for (const [contentId, entry] of terminals) {
    const visible = contentId === ui.openContentId;
    if (entry.phase === 'live' && (!visible || hostSession == null)) entry.phase = 'opening';
  }
  syncPhase();
}

/** Кадрите на терминала стигат до своя `TerminalView`; за пуснат терминал — до никого. */
export const forTerminal = (handler) => (m) => {
  const entry = terminals.get(m.contentId);
  if (entry) handler(entry, m, m.contentId === ui.openContentId);
};
