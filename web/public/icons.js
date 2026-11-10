// Иконите в „Сесии“ — същите Material Icons (Filled), като в Android `SessionIcons.kt`:
// repository е папка (етикет), worktree е клон (`account_tree`), а стрелката отваря реда.

const SVG = 'http://www.w3.org/2000/svg';

export const ICONS = {
  repository: 'M10,4H4c-1.1,0 -1.99,0.9 -1.99,2L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V8c0,-1.1 -0.9,-2 -2,-2h-8l-2,-2z',
  worktree: 'M22,11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z',
  open: 'M10,6L8.59,7.41 13.17,12l-4.58,4.59L10,18l6,-6z',
};

/** Икона 24 × 24 в размера на текста; цветът е `currentColor`. */
export function icon(name, className = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon icon-${name} ${className}`.trim());
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}
