// Чистите решения на екраните: какво да пише и какво да се вижда. Без DOM, за да се тестват в Node.

import { displayName } from './session-groups.js';

export function hostLabel(host) {
  return host?.name || 'Mac без име';
}

/** Избраният Mac от списъка на новия relay; `null` при стар relay или без избор. */
export function boundHost(state) {
  return Array.isArray(state?.hosts) ? state.hosts.find((h) => h.id === state.selectedHostId) ?? null : null;
}

function offlineText(state) {
  if (!Array.isArray(state.hosts)) return 'Mac-ът е офлайн';
  if (!state.selectedHostId) return 'Избери Mac';
  return `${boundHost(state) ? hostLabel(boundHost(state)) : 'Избраният Mac'} е извън линия`;
}

const CONNECTION_BANNERS = {
  unauthorized: () => ({ text: 'Relay-ът не прие ключа (401). Провери го.', error: true }),
  connecting: () => ({ text: 'Свързване с relay-а…' }),
  waiting: (s) => ({
    text: `Няма връзка${s.reason ? `: ${s.reason}` : ''}. Нов опит след ${Math.ceil((s.retryInMs ?? 0) / 1000)} s`,
    retry: true,
  }),
  connected: (s) => (s.path === 'none' ? { text: offlineText(s) } : null),
};

/** Лентата за връзката: `{text, error, retry}` или `null`, когато всичко е наред. */
export function bannerFor(state, linkUp) {
  if (!linkUp) return { text: 'Няма връзка с локалния сървър. Пусни web/run.sh и изчакай.', error: true };
  if (!state?.configured) return null;
  return CONNECTION_BANNERS[state.connection]?.(state) ?? null;
}

/** Текстът върху терминала или `null`, когато потокът тече. */
export function terminalStatusFor({ phase, state, endReason }) {
  if (phase === 'live') return null;
  if (phase === 'none') return { text: 'Избери таб отляво.' };
  if (phase === 'opening') return { text: state?.hostSession == null ? 'Чакам връзка с Mac-а…' : 'Свързване с таба…' };
  return { text: `Потокът спря: ${endReason}`, retry: true };
}

/** Заглавието на страницата: броят чакащи табове и отвореният таб. */
export function pageTitle({ found, state, awaiting }) {
  const name = found ? `${found.tab.title || 'Таб'} · ${displayName(found.worktree)}` : (state?.hostName || 'Supacode Remote');
  return `${awaiting ? `(${awaiting}) ` : ''}${name}`;
}

/**
 * Следващият worktree с табове в посока `step` (±1), по кръга. Без отворен: → тръгва от първия,
 * ← от последния. `null`, ако никой няма табове.
 */
export function nextWorktree(order, currentId, step) {
  const n = order.length;
  const at = order.findIndex((r) => r.worktree.id === currentId);
  const start = at >= 0 ? at : step > 0 ? -1 : 0;
  for (let k = 1; k <= n; k++) {
    const wt = order[(((start + step * k) % n) + n) % n].worktree;
    if ((wt.tabs ?? []).length) return wt;
  }
  return null;
}
