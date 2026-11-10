// „Mac-ове“: всеки Mac, който новият relay познава. Изборът отива в Node, който го записва и се
// свързва наново; тук само се показва.

import { $, el } from './dom.js';
import { hostLabel } from './view-model.js';
import { ui } from './ui-state.js';

let selectHost = () => {};

export function initHostsView(onSelect) {
  selectHost = onSelect;
}

export function showHosts() {
  renderHosts();
  $('hosts').hidden = false;
}

export function hideHosts() {
  $('hosts').hidden = true;
}

/** Отваря „Mac-ове“ на ръба false → true и го затваря на обратния (изборът е станал сам). */
export function followHostPick(pickBefore, pickNow) {
  if (pickNow && !pickBefore) showHosts();
  else if (!pickNow && pickBefore) hideHosts();
  else if (!$('hosts').hidden) renderHosts();
}

function hostRow(h) {
  const row = el('button', 'host-row');
  row.type = 'button';
  row.append(el('span', 'name', hostLabel(h)));
  row.append(el('span', h.online ? 'online' : 'offline', h.online ? 'на линия' : 'извън линия'));
  if (h.id === ui.state?.selectedHostId) row.append(el('span', 'badge', 'избран'));
  // Версията (УА6) е от `hello`, значи е известна само за Mac-а, с който сме свързани.
  if (h.id === ui.state?.boundHost && ui.state?.hostApp) row.append(el('span', 'app', ui.state.hostApp));
  row.addEventListener('click', () => {
    hideHosts();
    if (h.id !== ui.state?.selectedHostId) selectHost(h.id);
  });
  return row;
}

function renderHosts() {
  const box = $('host-list');
  const hosts = ui.state?.hosts ?? [];
  box.replaceChildren(...hosts.map(hostRow));
  if (!hosts.length) box.append(el('div', 'empty', 'Relay-ят още не познава друг Mac.'));
}
