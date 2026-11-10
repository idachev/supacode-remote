// Екраните на уеб app-а. Всичко към Mac-а минава през локалния Node сървър (`link.js`);
// тук са само показването и клавиатурата.

import { LocalLink } from './link.js';
import { TerminalView } from './terminal.js';
import { activityLabel, displayName, findTab, sessionRows, worktreeOrder } from './session-groups.js';

const $ = (id) => document.getElementById(id);
const FONT_KEY = 'supacode-web.newTabFont';
const COLLAPSED_KEY = 'supacode-web.collapsed';
const SIDEBAR_KEY = 'supacode-web.sidebarHidden';

const ui = {
  linkUp: false,
  state: null,
  list: null,
  listText: '',
  openContentId: null,
  /** 'none' | 'opening' | 'live' | 'ended' */
  phase: 'none',
  endReason: null,
  expanded: new Set(),
  collapsed: readJson(COLLAPSED_KEY, {}),
  query: '',
  newTabRef: null,
  newTabWorktreeId: null,
  suggestRef: null,
  refs: 0,
};

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* частен прозорец */ }
}

function newTabFont() {
  const v = Number(readJson(FONT_KEY, 14));
  return Number.isFinite(v) && v >= 8 && v <= 24 ? v : 14;
}

/** Случайно начало на всяка страница: отговор за заявка на друга страница не съвпада с наша. */
const REF_PREFIX = Math.random().toString(36).slice(2, 10);
const nextRef = () => `${REF_PREFIX}-${++ui.refs}`;

// ---- връзката с Node ----

const link = new LocalLink({
  onUp: () => {
    ui.linkUp = true;
    // След презареждане табът от адреса се отваря наново: attach-ът носи екрана.
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('c');
    if (fromHash) openTab(fromHash);
    render();
  },
  onDown: () => {
    ui.linkUp = false;
    // Отговорите на чакащите заявки няма да дойдат: Node е рестартиран.
    dropRequests();
    render();
  },
  onMessage,
});

const terminal = new TerminalView($('term'), $('term-area'), {
  onInput: (b64) => {
    if (ui.phase === 'live') link.send({ t: 'input', b64, contentId: ui.openContentId });
  },
});

function onMessage(m) {
  switch (m.t) {
    case 'state': {
      // Сървърът е пуснат наново (може и с нов код): страницата се зарежда наново, табът — от адреса.
      if (ui.state?.bootId && m.bootId !== ui.state.bootId) {
        location.reload();
        return;
      }
      const pickBefore = ui.state?.hostPick === true;
      ui.state = m;
      // Няма какво да се избере само (няколко Mac-а или записаният го няма): „Mac-ове“ се отваря.
      if (m.hostPick && !pickBefore) showHosts();
      // Изборът стана сам (напр. Mac излезе на линия): списъкът вече не трябва.
      else if (!m.hostPick && pickBefore) $('hosts').hidden = true;
      else if (!$('hosts').hidden) renderHosts();
      // Връзката с Mac-а падна: Node ще закачи таба наново, щом се върне.
      if (m.hostSession == null && ui.phase === 'live') ui.phase = 'opening';
      if (m.connection === 'unauthorized' || !m.configured) showSetup();
      render();
      break;
    }
    case 'list': {
      // Списъкът идва на 3 s; без промяна не се прерисува (иначе губи hover и фокуса на бутоните).
      const text = JSON.stringify(m);
      if (text === ui.listText) return;
      ui.listText = text;
      // Първият списък след презареждане: worktree-то на отворения таб се разгъва.
      if (!ui.list && ui.openContentId) {
        const found = findTab(m, ui.openContentId);
        if (found) ui.expanded.add(found.worktree.id);
      }
      ui.list = m;
      renderSessions();
      renderTerminalBar();
      break;
    }
    case 'attached':
      if (m.contentId !== ui.openContentId) return;
      ui.phase = 'live';
      terminal.init(m.cols, m.rows);
      renderTerminalStatus();
      terminal.focus();
      break;
    case 'out':
      if (m.contentId === ui.openContentId) terminal.write(m.b64);
      break;
    case 'size':
      if (m.contentId === ui.openContentId) terminal.resize(m.cols, m.rows);
      break;
    case 'detached':
      if (m.contentId !== ui.openContentId) return;
      ui.phase = 'ended';
      ui.endReason = m.reason || 'табът е затворен';
      renderTerminalStatus();
      break;
    case 'tab.new':
      if (m.ref !== ui.newTabRef) return;
      finishNewTab();
      openTab(m.contentId);
      break;
    case 'suggest':
      if (m.ref !== ui.suggestRef) return;
      ui.suggestRef = null;
      showSuggestions(m.suggestions);
      break;
    case 'error':
      if (m.ref && m.ref === ui.newTabRef) finishNewTab();
      if (m.ref && m.ref === ui.suggestRef) ui.suggestRef = null;
      toast(m.message || 'Грешка от host-а');
      break;
    case 'setup.result':
      if (m.ok) {
        $('setup').hidden = true;
        $('setup-key').value = '';
      } else {
        $('setup-error').textContent = m.message;
        $('setup-error').hidden = false;
      }
      break;
    case 'replaced':
      // Отговорите вече отиват към другата страница.
      dropRequests();
      $('replaced').hidden = false;
      break;
    case 'reset':
      // Нов ключ за връзка: табът и списъкът са на стария relay.
      ui.list = null;
      ui.listText = '';
      ui.openContentId = null;
      ui.phase = 'none';
      terminal.clear();
      history.replaceState(null, '', location.pathname);
      dropRequests();
      render();
      break;
    default:
      break;
  }
}

// ---- табове ----

function openTab(contentId) {
  if (!contentId) return;
  closeSuggestions();
  ui.openContentId = contentId;
  ui.phase = 'opening';
  ui.endReason = null;
  terminal.clear();
  history.replaceState(null, '', `#c=${encodeURIComponent(contentId)}`);
  const found = findTab(ui.list, contentId);
  if (found) ui.expanded.add(found.worktree.id);
  link.send({ t: 'open', contentId });
  render();
}

function currentTab() {
  return ui.openContentId ? findTab(ui.list, ui.openContentId) : null;
}

function newTab(worktreeId) {
  if (!worktreeId || ui.newTabRef) return;
  // Началният размер: колкото влиза в мястото при шрифта за нови табове (ОП27).
  const grid = terminal.gridAt(newTabFont());
  ui.newTabRef = nextRef();
  ui.newTabWorktreeId = worktreeId;
  link.send({ t: 'tab.new', worktreeId, cols: grid?.cols, rows: grid?.rows, ref: ui.newTabRef });
  renderSessions();
}

function dropRequests() {
  ui.suggestRef = null;
  closeSuggestions();
  if (ui.newTabRef) finishNewTab();
}

function finishNewTab() {
  ui.newTabRef = null;
  ui.newTabWorktreeId = null;
  renderSessions();
}

function moveTab(step) {
  const found = currentTab();
  const tabs = found?.worktree.tabs ?? [];
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.contentId === ui.openContentId);
  openTab(tabs[(i + step + tabs.length) % tabs.length].contentId);
}

function moveWorktree(step) {
  const order = worktreeOrder(sessionRows(ui.list, ui.collapsed, ''));
  if (!order.length) return;
  const found = currentTab();
  // Без отворен таб: → тръгва от първия, ← от последния.
  const at = found ? order.findIndex((r) => r.worktree.id === found.worktree.id) : -1;
  const i = at >= 0 ? at : step > 0 ? -1 : 0;
  for (let k = 1; k <= order.length; k++) {
    const n = order.length;
    const wt = order[(((i + step * k) % n) + n) % n].worktree;
    const tabs = wt.tabs ?? [];
    if (!tabs.length) continue;
    openTab((tabs.find((t) => t.focused) ?? tabs[0]).contentId);
    return;
  }
}

// ---- поле за ред и предложения ----

function toggleLine(show = $('line-form').hidden) {
  $('line-form').hidden = !show;
  if (show) $('line-input').focus();
  else terminal.focus();
}

/**
 * Редът от полето. Текстът и Enter (150 ms по-късно) праща Node: само той знае дали връзката
 * с Mac-а е същата, когато е ред на Enter (ОП33).
 */
function sendLine(text) {
  if (ui.phase !== 'live') return;
  link.send({ t: 'line', text, contentId: ui.openContentId });
}

function requestSuggestions() {
  if (ui.phase !== 'live' || ui.suggestRef) return;
  ui.suggestRef = nextRef();
  link.send({ t: 'suggest', ref: ui.suggestRef });
  showSuggestions(null);
}

function showSuggestions(items) {
  const box = $('suggestions');
  box.replaceChildren();
  box.hidden = false;
  if (items === null) {
    box.append(el('div', 'item muted', 'Питам Mac-а…'));
    return;
  }
  if (!items.length) {
    box.append(el('div', 'item muted', 'Няма предложения.'));
    return;
  }
  for (const text of items) {
    const item = el('div', 'item', text);
    // Предложението само пълни полето за ред. Никога не се праща само.
    item.addEventListener('click', () => {
      closeSuggestions();
      toggleLine(true);
      $('line-input').value = text;
      $('line-input').focus();
    });
    box.append(item);
  }
}

/** Затваря кутията и отменя чакащото „Предложи“: закъснял отговор не я отваря пак. */
function closeSuggestions() {
  ui.suggestRef = null;
  $('suggestions').hidden = true;
}

// ---- рисуване ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function render() {
  renderBanner();
  renderTopbar();
  renderSessions();
  renderTerminalBar();
  renderTerminalStatus();
}

function renderBanner() {
  const s = ui.state;
  let text = null;
  let error = false;
  let retry = false;
  if (!ui.linkUp) {
    text = 'Няма връзка с локалния сървър. Пусни web/run.sh и изчакай.';
    error = true;
  } else if (!s || !s.configured) {
    text = null;
  } else if (s.connection === 'unauthorized') {
    text = 'Relay-ът не прие ключа (401). Провери го.';
    error = true;
  } else if (s.connection === 'connecting') {
    text = 'Свързване с relay-а…';
  } else if (s.connection === 'waiting') {
    const secs = Math.ceil((s.retryInMs ?? 0) / 1000);
    text = `Няма връзка${s.reason ? `: ${s.reason}` : ''}. Нов опит след ${secs} s`;
    retry = true;
  } else if (s.connection === 'connected' && s.path === 'none') {
    const bound = boundHostInfo();
    if (Array.isArray(s.hosts) && !s.selectedHostId) text = 'Избери Mac';
    else if (Array.isArray(s.hosts)) text = `${bound ? hostLabel(bound) : 'Избраният Mac'} е извън линия`;
    else text = 'Mac-ът е офлайн';
  }
  $('banner').hidden = text == null;
  $('banner').classList.toggle('error', error);
  $('banner-text').textContent = text ?? '';
  $('banner-retry').hidden = !retry;
}

function hostLabel(h) {
  return h?.name || 'Mac без име';
}

function boundHostInfo() {
  const s = ui.state;
  return Array.isArray(s?.hosts) ? s.hosts.find((h) => h.id === s.selectedHostId) ?? null : null;
}

function showHosts() {
  renderHosts();
  $('hosts').hidden = false;
}

/** „Mac-ове“: всеки Mac, който relay-ят познава; изборът се записва и връзката тръгва наново. */
function renderHosts() {
  const box = $('host-list');
  box.replaceChildren();
  const hosts = ui.state?.hosts ?? [];
  if (!hosts.length) box.append(el('div', 'empty', 'Relay-ят още не познава друг Mac.'));
  for (const h of hosts) {
    const row = el('button', 'host-row');
    row.type = 'button';
    row.append(el('span', 'name', hostLabel(h)));
    row.append(el('span', h.online ? 'online' : 'offline', h.online ? 'на линия' : 'извън линия'));
    if (h.id === ui.state?.selectedHostId) row.append(el('span', 'badge', 'избран'));
    row.addEventListener('click', () => {
      $('hosts').hidden = true;
      if (h.id !== ui.state?.selectedHostId) link.send({ t: 'host.select', id: h.id });
    });
    box.append(row);
  }
}

function renderTopbar() {
  const s = ui.state;
  const multi = Array.isArray(s?.hosts);
  $('host-name').textContent = s?.hostName || (multi ? hostLabel(boundHostInfo()) : 'Supacode Remote');
  // С нов relay (списък с Mac-ове) името отваря „Mac-ове“; със стар е само заглавие.
  $('host-name').disabled = !multi;
  $('host-name').title = multi ? 'Смени Mac-а' : '';
  const chip = $('path-chip');
  chip.hidden = !s || s.path === 'none';
  chip.textContent = s?.path === 'lan' ? 'LAN' : 'Relay';
  chip.classList.toggle('relay', s?.path === 'relay');
  chip.title = s?.path === 'lan' ? 'Пряко, в една мрежа' : 'През relay-а';
  const found = currentTab();
  const awaiting = countAwaiting();
  const name = found ? `${found.tab.title || 'Таб'} · ${displayName(found.worktree)}` : (s?.hostName || 'Supacode Remote');
  document.title = `${awaiting ? `(${awaiting}) ` : ''}${name}`;
}

function countAwaiting() {
  let n = 0;
  for (const r of ui.list?.repos ?? []) for (const w of r.worktrees ?? []) for (const t of w.tabs ?? []) {
    if ((t.agents ?? []).some((a) => a.activity === 'awaitingInput')) n += 1;
  }
  return n;
}

function renderSessions() {
  const box = $('session-list');
  const s = ui.state;
  box.replaceChildren();
  if (!ui.list) {
    const waiting = s?.hostSession != null ? 'Чакам списъка от Mac-а…' : 'Чакам връзка с Mac-а…';
    box.append(el('div', 'empty', waiting));
    renderTopbar();
    return;
  }
  const rows = sessionRows(ui.list, ui.collapsed, ui.query);
  if (!rows.length) {
    box.append(el('div', 'empty', ui.query.trim() ? `Нищо не отговаря на „${ui.query.trim()}“` : 'Няма сесии.'));
  }
  const open = currentTab();
  for (const row of rows) box.append(...renderRow(row, open));
  renderTopbar();
}

function renderRow(row, open) {
  switch (row.kind) {
    case 'section':
      return [el('div', 'row row-section', row.title)];
    case 'group': {
      const node = el('div', `row row-group${row.collapsed ? ' collapsed' : ''}`, row.title);
      node.addEventListener('click', () => {
        ui.collapsed[row.id] = !row.collapsed;
        writeStorage(COLLAPSED_KEY, ui.collapsed);
        renderSessions();
      });
      return [node];
    }
    case 'repository':
      return [el('div', 'row row-repo', row.repository.name)];
    case 'status':
      return [el('div', 'row row-status', row.status === 'pinned' ? 'Закачени' : 'Активни')];
    case 'worktree':
      return renderWorktree(row, open);
    default:
      return [];
  }
}

function renderWorktree(row, open) {
  const wt = row.worktree;
  const isOpen = open?.worktree.id === wt.id;
  const expanded = ui.expanded.has(wt.id);
  const node = el('div', `row row-wt${isOpen ? ' current' : ''}`);
  const awaiting = (wt.tabs ?? []).some((t) => (t.agents ?? []).some((a) => a.activity === 'awaitingInput'));
  node.append(el('span', `dot${awaiting ? ' awaiting' : wt.working ? ' working' : ''}`));
  const label = row.repositoryName ? `${row.repositoryName} · ${displayName(wt)}` : displayName(wt);
  node.append(el('span', 'name', label));
  if (wt.status === 'main' && !row.repositoryName) node.append(el('span', 'badge', 'Основен'));
  if (wt.branch && wt.branch !== wt.name) node.append(el('span', 'branch', wt.branch));
  node.title = wt.branch ? `${label} — ${wt.branch}` : label;
  node.addEventListener('click', () => {
    if (expanded) ui.expanded.delete(wt.id);
    else ui.expanded.add(wt.id);
    renderSessions();
  });
  if (!expanded) return [node];
  const tabs = el('div', 'tabs');
  for (const tab of wt.tabs ?? []) {
    const t = el('div', `tab${tab.contentId === ui.openContentId ? ' open' : ''}`);
    t.append(el('span', 'name', tab.title || 'Таб'));
    for (const a of tab.agents ?? []) t.append(el('span', `badge ${a.activity}`, `${a.agent} · ${activityLabel(a.activity)}`));
    if (tab.readOnly) t.append(el('span', 'badge', 'само четене'));
    t.addEventListener('click', () => openTab(tab.contentId));
    tabs.append(t);
  }
  const pending = ui.newTabWorktreeId === wt.id;
  const add = el('button', 'new-tab', pending ? 'Отварям нов таб…' : '+ Нов таб');
  add.type = 'button';
  add.title = 'Нов таб в този worktree';
  add.disabled = pending || ui.state?.hostSession == null;
  add.addEventListener('click', () => newTab(wt.id));
  tabs.append(add);
  return [node, tabs];
}

function renderTerminalBar() {
  const found = currentTab();
  $('terminal-title').textContent = found
    ? `${found.repo.name} · ${displayName(found.worktree)} · ${found.tab.title || 'Таб'}`
    : '';
  const live = ui.phase === 'live';
  $('suggest-button').disabled = !live;
  $('line-button').disabled = !live;
  $('copy-all-button').disabled = ui.phase === 'none';
}

function renderTerminalStatus() {
  const status = $('term-status');
  const retry = $('term-retry');
  retry.hidden = true;
  status.classList.remove('overlay-light');
  if (ui.phase === 'live') {
    status.hidden = true;
  } else if (ui.phase === 'none') {
    status.hidden = false;
    $('term-status-text').textContent = 'Избери таб отляво.';
  } else if (ui.phase === 'opening') {
    status.hidden = false;
    $('term-status-text').textContent = ui.state?.hostSession == null ? 'Чакам връзка с Mac-а…' : 'Свързване с таба…';
  } else {
    status.hidden = false;
    status.classList.add('overlay-light');
    $('term-status-text').textContent = `Потокът спря: ${ui.endReason}`;
    retry.hidden = false;
  }
  renderTerminalBar();
}

let toastTimer = null;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4_000);
}

// ---- настройка ----

function showSetup() {
  if (!$('setup').hidden) return;
  $('setup-error').hidden = true;
  $('setup-font').value = String(newTabFont());
  const label = ui.state?.relayLabel;
  // Ключът не идва в страницата: показва се само relay-ят, а ключът — със звездички.
  $('setup-current').textContent = label ? `Записан: ${label}/••••••••` : '';
  $('setup-key').placeholder = label ? `${label}/••••••••` : 'Relay и ключ, разделени с „/“';
  $('setup-cancel').hidden = !ui.state?.configured;
  $('setup').hidden = false;
  $('setup-key').focus();
}

$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const font = Number($('setup-font').value);
  if (Number.isFinite(font) && font >= 8 && font <= 24) writeStorage(FONT_KEY, font);
  const key = $('setup-key').value.trim();
  if (!key) {
    if (ui.state?.configured) {
      $('setup').hidden = true;
      return;
    }
    $('setup-error').textContent = 'Липсва relay или ключ';
    $('setup-error').hidden = false;
    return;
  }
  link.send({ t: 'setup', connectionKey: key });
});

$('setup-cancel').addEventListener('click', () => { $('setup').hidden = true; terminal.focus(); });
$('setup-button').addEventListener('click', showSetup);
$('banner-retry').addEventListener('click', () => link.send({ t: 'reconnect' }));
$('term-retry').addEventListener('click', () => openTab(ui.openContentId));
$('takeover').addEventListener('click', () => {
  $('replaced').hidden = true;
  link.send({ t: 'takeover' });
  if (ui.openContentId) openTab(ui.openContentId);
});
$('host-name').addEventListener('click', showHosts);
$('hosts-close').addEventListener('click', () => { $('hosts').hidden = true; terminal.focus(); });
$('help-button').addEventListener('click', () => { $('help').hidden = false; });
$('help-close').addEventListener('click', () => { $('help').hidden = true; terminal.focus(); });
$('suggest-button').addEventListener('click', requestSuggestions);
$('line-button').addEventListener('click', () => toggleLine());
$('copy-all-button').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(terminal.allText());
    toast('Копирано');
  } catch {
    toast('Не мога да пиша в clipboard-а');
  }
});
$('toggle-sessions').addEventListener('click', () => toggleSidebar());
$('search').addEventListener('input', (e) => {
  ui.query = e.target.value;
  renderSessions();
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    ui.query = '';
    renderSessions();
    terminal.focus();
  }
});
$('line-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('line-input');
  sendLine(input.value);
  input.value = '';
});
$('line-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleLine(false);
});

function toggleSidebar(hidden = !$('sessions').classList.contains('hidden')) {
  $('sessions').classList.toggle('hidden', hidden);
  writeStorage(SIDEBAR_KEY, hidden);
}
toggleSidebar(readJson(SIDEBAR_KEY, false) === true);

// ---- клавишни комбинации: Ctrl+⌘ ----

function handleShortcut(e) {
  const actions = {
    ArrowUp: () => moveTab(-1),
    ArrowDown: () => moveTab(1),
    ArrowLeft: () => moveWorktree(-1),
    ArrowRight: () => moveWorktree(1),
    n: () => newTab(currentTab()?.worktree.id),
    s: requestSuggestions,
    l: () => toggleLine(),
    b: () => toggleSidebar(),
    // K, а не F: Ctrl+⌘+F е цял екран в macOS.
    k: () => {
      toggleSidebar(false);
      $('search').focus();
      $('search').select();
    },
  };
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!action) return false;
  e.preventDefault();
  e.stopPropagation();
  action();
  return true;
}

// В capture фазата, за да не стигне комбинацията до xterm.js или до полето.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.metaKey) handleShortcut(e);
  else if (e.key === 'Escape' && !$('suggestions').hidden) {
    // Esc само затваря предложенията: към агента би прекъснал работата му.
    e.preventDefault();
    e.stopPropagation();
    closeSuggestions();
  }
}, true);

render();
