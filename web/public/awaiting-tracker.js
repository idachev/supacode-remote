// УА2, както `AwaitingTracker` в Android: известие има само при преход към „чака вход“, не за
// всеки списък (идва на 3 s), в който табът още чака.

import { displayName, isAwaiting } from './session-groups.js';

function awaitingTabs(list) {
  return (list?.repos ?? []).flatMap((repo) => (repo.worktrees ?? []).flatMap((wt) =>
    (wt.tabs ?? []).filter(isAwaiting).map((tab) => ({
      contentId: tab.contentId,
      title: `${repo.name} · ${displayName(wt)} · ${tab.title || 'Таб'}`,
    }))));
}

export class AwaitingTracker {
  constructor() {
    this.reset();
  }

  /** Първият списък след старт или нова връзка само запомня: табовете, които вече чакат, са стари. */
  reset() {
    this.known = null;
  }

  /** Табовете, които чакат сега, а в предишния списък не чакаха. */
  update(list) {
    const now = awaitingTabs(list);
    const fresh = this.known ? now.filter((t) => !this.known.has(t.contentId)) : [];
    this.known = new Set(now.map((t) => t.contentId));
    return fresh;
  }
}
