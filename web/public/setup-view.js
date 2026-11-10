// „Настройка“: ключът за връзка, шрифтът за нови табове и известията. Ключът не идва в страницата: показва се
// само relay-ят, а ключът — със звездички.

import { $, writeStorage } from './dom.js';
import { syncNotifySetting } from './notify-view.js';
import { FONT_KEY, newTabFont, ui } from './ui-state.js';

let sendKey = () => {};
let onClose = () => {};

export function initSetupView({ onSave, onClosed }) {
  sendKey = onSave;
  onClose = onClosed;
  $('setup-form').addEventListener('submit', submit);
  $('setup-cancel').addEventListener('click', closeSetup);
}

export function showSetup() {
  if (!$('setup').hidden) return;
  $('setup-error').hidden = true;
  $('setup-font').value = String(newTabFont());
  syncNotifySetting();
  const label = ui.state?.relayLabel;
  $('setup-current').textContent = label ? `Записан: ${label}/••••••••` : '';
  $('setup-key').placeholder = label ? `${label}/••••••••` : 'Relay и ключ, разделени с „/“';
  $('setup-cancel').hidden = !ui.state?.configured;
  $('setup').hidden = false;
  $('setup-key').focus();
}

export function setupResult({ ok, message }) {
  if (ok) {
    $('setup').hidden = true;
    $('setup-key').value = '';
    return;
  }
  showError(message);
}

function closeSetup() {
  $('setup').hidden = true;
  onClose();
}

function showError(text) {
  $('setup-error').textContent = text;
  $('setup-error').hidden = false;
}

function saveFont() {
  const font = Number($('setup-font').value);
  if (Number.isFinite(font) && font >= 8 && font <= 24) writeStorage(FONT_KEY, font);
}

/** Празно поле при записан ключ оставя ключа; без записан е грешка. */
function submit(e) {
  e.preventDefault();
  saveFont();
  const key = $('setup-key').value.trim();
  if (key) sendKey(key);
  else if (ui.state?.configured) closeSetup();
  else showError('Липсва relay или ключ');
}
