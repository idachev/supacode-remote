// „Размер по този екран“ (ЗД12): host-ът отговаря на `resize` със `size` или с `error`
// `resize_failed`; стар host праща `size` само ако размерът се е сменил. Без тези съобщения
// натискането изглеждаше като „нищо не става“.

/** Колко чака страницата `size`: заспал таб host-ът събужда и оразмерява до ~6 s. */
export const RESIZE_REPLY_MS = 8_000;

/** `error.code`, с който host-ът казва, че не е сменил размера. */
export const RESIZE_FAILED = 'resize_failed';

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

/** Отказът на Mac-а (`resize_failed`): причината от host-а е на английски, кратка. */
export function resizeFailedText(message) {
  return message ? `Размерът не се смени: ${message}` : 'Размерът не се смени';
}

/** Версията на Supacode на Mac-а към съобщение за грешка или отговор (УА6); стар Mac не я казва. */
export function withHostApp(text, app) {
  return app ? `${text} · ${app}` : text;
}
