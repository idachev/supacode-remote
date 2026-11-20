// „Предложи“ и полето за ред. Предложението само пълни полето; никога не се праща само.
// Редът от полето праща Node (текстът, после Enter след 150 ms, ОП33).

import { $, el, toast } from './dom.js';
import { nextRef, ui } from './ui-state.js';
import { LINE_NOT_SENT } from './line-not-sent.js';

let link = null;
let terminal = null;

export function initSuggestions(deps) {
  ({ link, terminal } = deps);
  $('line-form').addEventListener('submit', (e) => {
    e.preventDefault();
    // КЛ5: неизпратен ред остава в полето, иначе би се изгубил без дума.
    if (sendLine($('line-input').value)) $('line-input').value = '';
    else toast(LINE_NOT_SENT);
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
  if (ui.phase !== 'live') return false;
  link.send({ t: 'line', text, contentId: ui.openContentId });
  return true;
}

/**
 * Node не прати реда (КЛ5): табът се е откачил, докато редът е пътувал (смяна на пътя). Текстът се
 * връща в полето, ако там още няма нов и табът е същият.
 */
export function restoreLine(m) {
  if (m.contentId === ui.openContentId && !$('line-input').value) $('line-input').value = m.text;
  toast(m.message || LINE_NOT_SENT);
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
