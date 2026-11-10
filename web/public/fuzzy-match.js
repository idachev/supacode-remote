// Търсене, което търпи грешки при писане (пренесено от Android `FuzzyMatch.kt`): липсваща,
// излишна или сменена буква и две разменени съседни букви. Търсеното може да е където и да е
// в името. Грешките растат с дължината, иначе кратка дума би намирала почти всичко.

/** До 3 букви — точно; 4–5 — една грешка; от 6 нагоре — две. */
export function allowedErrors(query) {
  if (query.length <= 3) return 0;
  if (query.length <= 5) return 1;
  return 2;
}

export function fuzzyMatches(text, query) {
  const q = String(query).toLowerCase();
  const t = String(text ?? '').toLowerCase();
  if (t.includes(q)) return true;
  const maxErrors = allowedErrors(q);
  return maxErrors > 0 && bestDistance([...t], [...q]) <= maxErrors;
}

/**
 * Най-малкото разстояние между `q` и парче от `t` (Sellers, с размяна на съседни букви като при
 * Damerau). Началото в `t` е без цена; краят е най-малкото в последния ред.
 */
function bestDistance(t, q) {
  const m = q.length;
  let prev2 = new Array(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let best = prev[m];
  for (let j = 1; j <= t.length; j++) {
    const cur = new Array(m + 1).fill(0);
    for (let i = 1; i <= m; i++) {
      const cost = q[i - 1] === t[j - 1] ? 0 : 1;
      let d = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + cost);
      if (i > 1 && j > 1 && q[i - 1] === t[j - 2] && q[i - 2] === t[j - 1]) d = Math.min(d, prev2[i - 2] + 1);
      cur[i] = d;
    }
    best = Math.min(best, cur[m]);
    prev2 = prev;
    prev = cur;
  }
  return best;
}
