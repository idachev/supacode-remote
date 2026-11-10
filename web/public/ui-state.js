// Състоянието на страницата: какво е дошло от Node и какво е избрал потребителят тук.

import { readJson } from './dom.js';
import { findTab } from './session-groups.js';

export const FONT_KEY = 'supacode-web.newTabFont';
export const COLLAPSED_KEY = 'supacode-web.collapsed';
export const SIDEBAR_KEY = 'supacode-web.sidebarHidden';

export const ui = {
  linkUp: false,
  state: null,
  list: null,
  listText: '',
  openContentId: null,
  /** 'none' | 'opening' | 'live' | 'ended' */
  phase: 'none',
  endReason: null,
  expanded: new Set(),
  collapsed: readJson(COLLAPSED_KEY, {}),
  query: '',
  newTabRef: null,
  newTabWorktreeId: null,
  suggestRef: null,
  refs: 0,
};

/** Случайно начало на всяка страница: отговор за заявка на друга страница не съвпада с наша. */
const REF_PREFIX = Math.random().toString(36).slice(2, 10);

export function nextRef() {
  ui.refs += 1;
  return `${REF_PREFIX}-${ui.refs}`;
}

/** Шрифтът, при който се смята размерът на нов таб (ОП27); 8–24 px, по подразбиране 14. */
export function newTabFont() {
  const v = Number(readJson(FONT_KEY, 14));
  return Number.isFinite(v) && v >= 8 && v <= 24 ? v : 14;
}

/** Отвореният таб с worktree-то и repository-то му, ако е в последния списък. */
export function currentTab() {
  return ui.openContentId ? findTab(ui.list, ui.openContentId) : null;
}
