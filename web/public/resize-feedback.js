// „Размер по този екран“ (ЗД12): host-ът не отговаря пряко на `resize`, а праща `size` само ако
// размерът се е сменил. Без тези съобщения натискането изглеждаше като „нищо не става“.

/** Колко чака страницата `size`, преди да каже, че Mac-ът не е отговорил. */
export const RESIZE_REPLY_MS = 4_000;

export const RESIZE_SILENT = 'Mac-ът не отговори на „Размер по този екран“: Supacode на Mac-а може да е стар.';

const dims = ({ cols, rows }) => `${cols} × ${rows}`;

/** Дали да се праща и какво да види потребителят. Същия размер Mac-ът не би потвърдил. */
export function resizeAskText(grid, current) {
  if (grid.cols === current.cols && grid.rows === current.rows) return { send: false, text: `Табът вече е ${dims(grid)}` };
  return { send: true, text: `Пратено към Mac-а: ${dims(grid)}…` };
}

/** Отговорът `size` след натискането: поисканият размер или друг (Mac-ът ограничава размера). */
export function resizeReplyText(asked, size) {
  if (asked.cols === size.cols && asked.rows === size.rows) return `Mac-ът смени таба на ${dims(size)}`;
  return `Mac-ът върна ${dims(size)} (поискано ${dims(asked)})`;
}

/** Версията на Supacode на Mac-а към съобщение за грешка или отговор (УА6); стар Mac не я казва. */
export function withHostApp(text, app) {
  return app ? `${text} · ${app}` : text;
}
