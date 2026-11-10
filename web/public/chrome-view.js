// Рамката около терминала: лентата за връзката, горната лента, лентата на терминала и текстът
// върху терминала, докато потокът не тече.

import { $ } from './dom.js';
import { countAwaiting, displayName } from './session-groups.js';
import { currentTab, ui } from './ui-state.js';
import { bannerFor, boundHost, hostLabel, pageTitle, terminalStatusFor } from './view-model.js';

export function renderBanner() {
  const banner = bannerFor(ui.state, ui.linkUp);
  $('banner').hidden = banner == null;
  $('banner').classList.toggle('error', banner?.error === true);
  $('banner-text').textContent = banner?.text ?? '';
  $('banner-retry').hidden = banner?.retry !== true;
}

function renderHostName(s) {
  const multi = Array.isArray(s?.hosts);
  $('host-name').textContent = s?.hostName || (multi ? hostLabel(boundHost(s)) : 'Supacode Remote');
  // С нов relay (списък с Mac-ове) името отваря „Mac-ове“; със стар е само заглавие.
  $('host-name').disabled = !multi;
  $('host-name').title = multi ? 'Смени Mac-а' : '';
}

function renderPathChip(s) {
  const chip = $('path-chip');
  chip.hidden = !s || s.path === 'none';
  chip.textContent = s?.path === 'lan' ? 'LAN' : 'Relay';
  chip.classList.toggle('relay', s?.path === 'relay');
  chip.title = s?.path === 'lan' ? 'Пряко, в една мрежа' : 'През relay-а';
}

export function renderTopbar() {
  renderHostName(ui.state);
  renderPathChip(ui.state);
  document.title = pageTitle({ found: currentTab(), state: ui.state, awaiting: countAwaiting(ui.list) });
}

export function renderTerminalBar() {
  const found = currentTab();
  const title = found ? `${found.repo.name} · ${displayName(found.worktree)} · ${found.tab.title || 'Таб'}` : '';
  // Над два реда текстът се реже; целият е в подсказката.
  $('terminal-title').textContent = title;
  $('terminal-title').title = title;
  const live = ui.phase === 'live';
  $('suggest-button').disabled = !live;
  $('line-button').disabled = !live;
  $('copy-all-button').disabled = ui.phase === 'none';
  $('fit-button').disabled = !live;
}

export function renderTerminalStatus() {
  const status = terminalStatusFor({ phase: ui.phase, state: ui.state, endReason: ui.endReason });
  $('term-status').hidden = status == null;
  // Спрял поток: текстът е върху последния екран, не на празно.
  $('term-status').classList.toggle('overlay-light', status?.retry === true);
  $('term-status-text').textContent = status?.text ?? '';
  $('term-retry').hidden = status?.retry !== true;
  renderTerminalBar();
}
