// „Предложи“ и полето за ред. Предложението само пълни полето; никога не се праща само.
// Редът от полето праща Node (текстът, после Enter след 150 ms, ОП33).

import { $, el } from './dom.js';
import { nextRef, ui } from './ui-state.js';

let link = null;
let terminal = null;

export function initSuggestions(deps) {
  ({ link, terminal } = deps);
  $('line-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendLine($('line-input').value);
    $('line-input').value = '';
  });
  $('line-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleLine(false);
  });
}

export function toggleLine(show = $('line-form').hidden) {
  $('line-form').hidden = !show;
  if (show) $('line-input').focus();
  else terminal.focus();
}

function sendLine(text) {
  if (ui.phase === 'live') link.send({ t: 'line', text, contentId: ui.openContentId });
}

export function requestSuggestions() {
  if (ui.phase !== 'live' || ui.suggestRef) return;
  ui.suggestRef = nextRef();
  link.send({ t: 'suggest', ref: ui.suggestRef });
  showSuggestions(null);
}

/** `null` — още питаме Mac-а. */
export function showSuggestions(items) {
  const box = $('suggestions');
  box.hidden = false;
  if (items === null) return box.replaceChildren(el('div', 'item muted', 'Питам Mac-а…'));
  if (!items.length) return box.replaceChildren(el('div', 'item muted', 'Няма предложения.'));
  return box.replaceChildren(...items.map(suggestionItem));
}

function suggestionItem(text) {
  const item = el('div', 'item', text);
  item.addEventListener('click', () => {
    closeSuggestions();
    toggleLine(true);
    $('line-input').value = text;
    $('line-input').focus();
  });
  return item;
}

/** Затваря кутията и отменя чакащото „Предложи“: закъснял отговор не я отваря пак. */
export function closeSuggestions() {
  ui.suggestRef = null;
  $('suggestions').hidden = true;
}

export function suggestionsOpen() {
  return !$('suggestions').hidden;
}
