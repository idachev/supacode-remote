// Подсказките за името на нов worktree (ЗД11), проверени тук, преди заявката да тръгне. Това е
// част от правилата на git (`git check-ref-format`); последната дума е на Mac-а. Същите правила и
// същите примери в тестовете има и в Android `WorktreeName.kt`.

/** Mac-ът отказва име над толкова байта UTF-8 (след trim) с `worktree_invalid`. */
export const MAX_NAME_BYTES = 200;

const FORBIDDEN = /[~^:?*[\\]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Причината името да не става, или `null`. `existing` са имената и branch-овете на worktree-тата
 * в това repository: Mac-ът сравнява без значение от главни и малки букви.
 */
export function worktreeNameHint(raw, existing = []) {
  const name = String(raw ?? '').trim();
  if (!name) return 'Напиши име на branch';
  if (/\s/.test(name)) return 'Без интервали в името';
  if (name.startsWith('-')) return 'Името не може да започва с „-“';
  if (name.includes('..')) return 'Името не може да съдържа „..“';
  if (FORBIDDEN.test(name) || CONTROL.test(name)) return 'Без знаците ~ ^ : ? * [ \\ в името';
  if (name.endsWith('/') || name.endsWith('.lock')) return 'Името не може да завършва на „/“ или „.lock“';
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return `Името е по-дълго от ${MAX_NAME_BYTES} байта`;
  const lower = name.toLowerCase();
  if (existing.some((n) => typeof n === 'string' && n.toLowerCase() === lower)) return 'Вече има worktree или branch с това име';
  return null;
}

/** Имената и branch-овете на worktree-тата в repository-то от пълния списък (не от търсенето). */
export function existingNames(list, repositoryId) {
  const repo = (list?.repos ?? []).find((r) => r.id === repositoryId);
  return (repo?.worktrees ?? []).flatMap((w) => [w.name, w.branch]).filter(Boolean);
}
