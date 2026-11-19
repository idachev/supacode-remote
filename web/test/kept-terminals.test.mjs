// HostController с `watch` и живите терминали (`attach keep`, ДЗ5, ДЗ7–ДЗ12, ДЗ22) срещу mock-а.
// Mock-ът е без LAN: смяната на пътя е нова сесия и би сложила attach-ове, които тук не се гледат.
// Броят се кадрите в лога на mock-а („message received … type: attach“), а `list` — по
// изпратеното от `RelayClient`, защото mock-ът не пише `list` в лога.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient } from '../src/relay-client.mjs';
import { HostController } from '../src/host-controller.mjs';
import { startMock, waitFor } from './helpers/mock.mjs';
import { connect as rawConnect, takeId } from './helpers/mock-client.mjs';

let mock;
before(async () => { mock = await startMock({ lan: false }); });
after(async () => { await mock?.stop(); });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function client(t, target = mock, { hostId = null, timing = {}, ...options } = {}) {
  const relay = new RelayClient({ timing });
  const sent = [];
  const send = relay.send.bind(relay);
  relay.send = (message) => {
    sent.push(message);
    return send(message);
  };
  const host = new HostController(relay, { listIntervalMs: 60_000, ...options });
  const messages = [];
  host.on('message', (m) => messages.push(m));
  t.after(() => {
    host.setActive(false);
    relay.stop();
  });
  relay.configure(target.settings, hostId);
  const mark = () => target.log().length;
  /** Кадрите от този тип в лога на mock-а след `from`, по желание само за един терминал. */
  const frames = (from, type, contentId = null, endpoint = 'client') => target.log().slice(from).split('\n')
    .filter((l) => l.includes(`message received, endpoint: ${endpoint}, type: ${type},`) &&
      (contentId == null || l.includes(`"contentId":"${contentId}"`)));
  const released = () => messages.filter((m) => m.t === 'released').map((m) => m.contentId);
  const attachedFor = (contentId) => messages.filter((m) => m.t === 'attached' && m.contentId === contentId).length;
  return { relay, host, sent, messages, mark, frames, released, attachedFor };
}

const ready = (c) => waitFor(() => c.relay.state.hostSession != null && c.relay.state.caps, 'сесия с caps');
const text = (c, contentId) => c.messages.filter((m) => m.t === 'out' && m.contentId === contentId)
  .map((m) => Buffer.from(m.b64, 'base64').toString('utf8')).join('');
const b64 = (s) => Buffer.from(s).toString('base64');

test('с watch в caps списъкът идва без питане на 3 s', async (t) => {
  const c = client(t, mock, { listIntervalMs: 200 });
  c.host.setActive(true);
  await ready(c);
  await waitFor(() => c.sent.some((m) => m.t === 'watch' && m.on), 'watch on');
  const lists = () => c.sent.filter((m) => m.t === 'list').length;
  const before = lists();
  await pause(1_000);
  assert.equal(lists(), before, 'list по таймера при watch');
  // Промяна на Mac-а стига сама, като push (`id:null`).
  c.host.open('content-idle');
  await waitFor(() => c.attachedFor('content-idle') === 1, 'attached');
  const mark = c.messages.length;
  c.host.input(b64('mock-await\r'), 'content-idle');
  await waitFor(() => c.messages.slice(mark).some((m) => m.t === 'list' && JSON.stringify(m).includes('"awaitingInput"')), 'list с промяната');
  assert.equal(lists(), before);
  // Без страница watch-ът спира.
  c.host.input(b64('mock-busy\r'), 'content-idle');
  c.host.setActive(false);
  assert.deepEqual(c.sent.filter((m) => m.t === 'watch').map((m) => m.on), [true, false]);
});

test('без watch в caps (стар Mac) списъкът се пита по таймера', async (t) => {
  const legacy = await startMock({ lan: false, env: { MOCK_SINGLE_HOST: '0', MOCK_OLD_RELAY: '0', MOCK_LEGACY: '1' } });
  t.after(() => legacy.stop());
  const c = client(t, legacy, { hostId: 'default', listIntervalMs: 200 });
  c.host.setActive(true);
  await ready(c);
  // ДЗ26: стар Supacode (`default`) не праща `caps`.
  assert.deepEqual(c.relay.state.caps, []);
  const before = c.sent.filter((m) => m.t === 'list').length;
  await pause(1_000);
  assert.ok(c.sent.filter((m) => m.t === 'list').length >= before + 3, 'list по таймера');
  assert.equal(c.sent.some((m) => m.t === 'watch'), false);
  // RF5: смяната на таб е detach + attach без keep, както преди.
  const list = await waitFor(() => c.host.lastList, 'list');
  const [a, b] = list.repos.flatMap((r) => r.worktrees.flatMap((w) => w.tabs.map((tab) => tab.contentId)));
  const from = c.mark();
  c.host.open(a);
  await waitFor(() => c.attachedFor(a) === 1, 'attached A');
  c.host.open(b);
  await waitFor(() => c.attachedFor(b) === 1, 'attached B');
  assert.equal(c.frames(from, 'detach', a).length, 1);
  assert.equal(c.frames(from, 'attach').some((l) => l.includes('"keep"')), false);
  assert.deepEqual(c.released(), [a]);
  assert.deepEqual(c.host.kept, [b]);
});

test('A → B → A не прави нов attach за A', async (t) => {
  const c = client(t);
  c.host.setActive(true);
  await ready(c);
  const from = c.mark();
  c.host.open('content-shell-main');
  await waitFor(() => c.attachedFor('content-shell-main') === 1, 'attached A');
  c.host.open('content-compact');
  await waitFor(() => c.attachedFor('content-compact') === 1, 'attached B');
  c.host.open('content-shell-main');
  assert.equal(c.host.openContentId, 'content-shell-main');
  // Входът отива във видимия A, без нов attach.
  assert.equal(c.host.input(b64('echo kept-$((20+3))\r'), 'content-shell-main'), true);
  await waitFor(() => text(c, 'content-shell-main').includes('kept-23'), 'ехото в A');
  const attaches = c.frames(from, 'attach');
  assert.equal(attaches.length, 2, attaches.join('\n'));
  assert.ok(attaches.every((l) => l.includes('"keep":true')));
  assert.equal(c.frames(from, 'detach').length, 0);
  assert.deepEqual(c.host.kept, ['content-shell-main', 'content-compact']);
});

test('деветият таб пуска най-отдавна видяния', async (t) => {
  const c = client(t, mock, { keptLimit: 2 });
  c.host.setActive(true);
  await ready(c);
  const from = c.mark();
  for (const id of ['content-shell-main', 'content-compact', 'content-idle']) {
    c.host.open(id);
    await waitFor(() => c.attachedFor(id) === 1, `attached ${id}`);
  }
  assert.deepEqual(c.released(), ['content-shell-main']);
  await waitFor(() => c.frames(from, 'detach', 'content-shell-main').length === 1, 'detach за A');
  assert.deepEqual(c.host.kept, ['content-idle', 'content-compact']);
  // Пуснатият таб при връщане прави attach наново.
  c.host.open('content-shell-main');
  await waitFor(() => c.attachedFor('content-shell-main') === 2, 'нов attached A');
  assert.deepEqual(c.released(), ['content-shell-main', 'content-compact']);
});

test('нова hostSession: attach само на видимия, скритият при връщане', async (t) => {
  const c = client(t);
  c.host.setActive(true);
  await ready(c);
  c.host.open('content-compact');
  await waitFor(() => c.attachedFor('content-compact') === 1, 'attached скрития');
  c.host.open('content-codex');
  await waitFor(() => c.attachedFor('content-codex') === 1, 'attached видимия');
  const session = c.relay.state.hostSession;
  const from = c.mark();
  c.host.input(b64('mock-offline\r'), 'content-codex');
  await waitFor(() => c.relay.state.hostSession == null, 'офлайн');
  await waitFor(() => c.relay.state.hostSession > session, 'нова сесия', 10_000);
  await waitFor(() => c.attachedFor('content-codex') === 2, 'нов attached на видимия');
  await pause(300);
  assert.equal(c.frames(from, 'attach', 'content-compact').length, 0);
  assert.ok(c.host.needsAttach.has('content-compact'));
  // Нова сесия: watch наново.
  assert.equal(c.sent.filter((m) => m.t === 'watch' && m.on).length, 2);
  c.host.open('content-compact');
  await waitFor(() => c.attachedFor('content-compact') === 2, 'attached на скрития при връщане');
  assert.equal(c.frames(from, 'attach', 'content-compact').length, 1);
  assert.equal(c.released().length, 0);
});

test('скрит таб, изчезнал от list, получава detach', async (t) => {
  const c = client(t);
  c.host.setActive(true);
  await ready(c);
  c.host.open('content-idle');
  await waitFor(() => c.attachedFor('content-idle') === 1, 'attached скрития');
  c.host.open('content-shell-main');
  await waitFor(() => c.attachedFor('content-shell-main') === 1, 'attached видимия');
  const list = await waitFor(() => c.host.lastList, 'list');
  const from = c.mark();
  // Стар Mac затваря таб без `detached`: само следващият `list` е без него (ДЗ12).
  const without = structuredClone(list);
  for (const r of without.repos) for (const w of r.worktrees) w.tabs = w.tabs.filter((tab) => tab.contentId !== 'content-idle');
  c.relay.emit('message', without);
  assert.deepEqual(c.released(), ['content-idle']);
  assert.deepEqual(c.host.kept, ['content-shell-main']);
  await waitFor(() => c.frames(from, 'detach', 'content-idle').length === 1, 'detach за скрития');
  // Видимият не се пипа, дори да липсва в списъка: за него Mac-ът праща `detached`.
  c.relay.emit('message', { ...without, repos: [] });
  assert.deepEqual(c.host.kept, ['content-shell-main']);
});

test('скрит таб, затворен на Mac-а, излиза от набора (detached)', async (t) => {
  const c = client(t);
  c.host.setActive(true);
  await ready(c);
  c.host.newTab({ worktreeId: 'wt-main', ref: 'n1' });
  const created = await waitFor(() => c.messages.find((m) => m.t === 'tab.new' && m.ref === 'n1'), 'нов таб');
  c.host.open(created.contentId);
  await waitFor(() => c.attachedFor(created.contentId) === 1, 'attached на новия');
  c.host.open('content-shell-main');
  await waitFor(() => c.attachedFor('content-shell-main') === 1, 'attached видимия');
  const other = await rawConnect(mock);
  t.after(() => other.close());
  await other.request({ t: 'tab.close', tabId: created.tabId });
  await waitFor(() => c.released().includes(created.contentId), 'released');
  assert.deepEqual(c.host.kept, ['content-shell-main']);
  // `detached` за скрития не стига до страницата като край на видимия таб.
  assert.equal(c.messages.some((m) => m.t === 'detached'), false);
  assert.equal(c.host.input(b64('echo still-$((3+4))\r'), 'content-shell-main'), true);
  await waitFor(() => text(c, 'content-shell-main').includes('still-7'), 'видимият работи');
});

test('вход към скрит таб не тръгва', async (t) => {
  const c = client(t);
  c.host.setActive(true);
  await ready(c);
  c.host.open('content-compact');
  await waitFor(() => c.attachedFor('content-compact') === 1, 'attached скрития');
  c.host.open('content-idle');
  await waitFor(() => c.attachedFor('content-idle') === 1, 'attached видимия');
  assert.equal(c.host.input(b64('x'), 'content-compact'), false);
  assert.equal(c.host.line('echo x', 'content-compact'), false);
  assert.equal(c.host.resize({ contentId: 'content-compact', cols: 100, rows: 30 }), false);
  assert.equal(c.host.input(b64(' '), 'content-idle'), true);
});

test('attach_limit свива набора до видимия и закача пак', async (t) => {
  const limited = await startMock({ lan: false, env: { MOCK_ATTACH_LIMIT: '2' } });
  t.after(() => limited.stop());
  const c = client(t, limited);
  c.host.setActive(true);
  await ready(c);
  c.host.open('content-shell-main');
  await waitFor(() => c.attachedFor('content-shell-main') === 1, 'attached A');
  c.host.open('content-compact');
  await waitFor(() => c.attachedFor('content-compact') === 1, 'attached B');
  const from = c.mark();
  c.host.open('content-idle');
  await waitFor(() => c.attachedFor('content-idle') === 1, 'attached C след свиването');
  assert.deepEqual(c.released().sort(), ['content-compact', 'content-shell-main']);
  assert.deepEqual(c.host.kept, ['content-idle']);
  assert.equal(c.frames(from, 'attach', 'content-idle').length, 2);
  // Грешката е обработена тук: страницата не я вижда.
  assert.equal(c.messages.some((m) => m.t === 'error'), false);
});

// RF1: Task 2 (watch по сокет), Task 4 (gate по терминал) и Task 5 (набора) заедно при relay → LAN.
test('relay → LAN при живи табове: по relay-а detach за всички и watch off, по LAN attach само на видимия', async (t) => {
  const lanMock = await startMock();
  t.after(() => lanMock.stop());
  const c = client(t, lanMock, { timing: { lanRetryFirstMs: 300, lanRetryMaxMs: 600 } });
  c.host.setActive(true);
  await waitFor(() => c.relay.state.path === 'lan' && c.relay.state.caps, 'LAN с caps');
  c.host.open('content-shell-main');
  await waitFor(() => c.attachedFor('content-shell-main') === 1, 'attached по LAN');
  const watches = () => c.sent.filter((m) => m.t === 'watch' && m.on).length;
  const watchesOnLan = watches();
  c.host.input(b64('mock-lan-off\r'), 'content-shell-main');
  await waitFor(() => c.relay.state.path === 'relay' && c.relay.state.caps, 'relay с caps');
  await waitFor(() => c.attachedFor('content-shell-main') === 2, 'attached по relay-а');
  await waitFor(() => watches() === watchesOnLan + 1, 'watch по relay-а');
  for (const id of ['content-compact', 'content-idle', 'content-codex']) {
    c.host.open(id);
    await waitFor(() => c.attachedFor(id) === 1, `attached ${id}`);
  }
  const from = c.mark();
  c.host.input(b64('mock-lan-on\r'), 'content-codex');
  await waitFor(() => c.relay.state.path === 'lan', 'пак LAN', 10_000);
  await waitFor(() => c.attachedFor('content-codex') === 2, 'attached на видимия по LAN');
  const relayDetaches = ['content-codex', 'content-idle', 'content-compact', 'content-shell-main'];
  await waitFor(() => relayDetaches.every((id) => c.frames(from, 'detach', id).length === 1), 'detach по relay-а за всички');
  assert.equal(c.frames(from, 'watch').filter((l) => l.includes('"on":false')).length, 1);
  const lanAttaches = c.frames(from, 'attach', null, 'lan');
  assert.equal(lanAttaches.length, 1, lanAttaches.join('\n'));
  assert.ok(lanAttaches[0].includes('"contentId":"content-codex"'));
  assert.equal(c.frames(from, 'detach', null, 'lan').length, 0);
  // Изходът на видимия тече по LAN, нищо не е изгубено.
  c.host.input(b64('echo lan-$((5*5))\r'), 'content-codex');
  await waitFor(() => text(c, 'content-codex').includes('lan-25'), 'ехото по LAN');
  // Скрит таб при връщане: един attach по LAN, с keep (caps на LAN сокета вече са дошли).
  await waitFor(() => c.relay.state.caps, 'caps по LAN');
  c.host.open('content-idle');
  await waitFor(() => c.attachedFor('content-idle') === 2, 'attached на скрития по LAN');
  const idle = c.frames(from, 'attach', 'content-idle', 'lan');
  assert.equal(idle.length, 1);
  assert.ok(idle[0].includes('"keep":true'));
  assert.deepEqual(c.released(), []);
});

// ДЗ8a без видим таб: скритите не чакат `attached` на видим по новия път — detach по стария веднага.
test('relay → LAN без видим таб: скритите получават detach по relay-а, при връщане — един attach по LAN', async (t) => {
  const lanMock = await startMock();
  t.after(() => lanMock.stop());
  const c = client(t, lanMock, { timing: { lanRetryFirstMs: 300, lanRetryMaxMs: 600 } });
  c.host.setActive(true);
  await waitFor(() => c.relay.state.path === 'lan' && c.relay.state.caps, 'LAN с caps');
  c.host.open('content-shell-main');
  await waitFor(() => c.attachedFor('content-shell-main') === 1, 'attached по LAN');
  c.host.input(b64('mock-lan-off\r'), 'content-shell-main');
  await waitFor(() => c.relay.state.path === 'relay' && c.relay.state.caps, 'relay с caps');
  await waitFor(() => c.attachedFor('content-shell-main') === 2, 'attached по relay-а');
  c.host.open('content-compact');
  await waitFor(() => c.attachedFor('content-compact') === 1, 'attached на втория');
  c.host.open('content-idle');
  await waitFor(() => c.attachedFor('content-idle') === 1, 'attached на третия');
  // Видимият се затваря (изтрит worktree): остават само скрити.
  c.host.close();
  assert.equal(c.host.visible, null);
  assert.deepEqual(c.host.kept, ['content-compact', 'content-shell-main']);
  const from = c.mark();
  // LAN се връща от друг клиент: на страницата няма видим таб, в който да се пише.
  const other = await rawConnect(lanMock);
  t.after(() => other.close());
  await other.request({ t: 'attach', contentId: 'content-codex', scrollback: 0 });
  other.send({ t: 'input', id: takeId(), contentId: 'content-codex', b64: b64('mock-lan-on\r') });
  await waitFor(() => c.relay.state.path === 'lan', 'пак LAN', 10_000);
  await waitFor(() => ['content-compact', 'content-shell-main'].every((id) => c.frames(from, 'detach', id).length === 1), 'detach по relay-а за скритите');
  assert.equal(c.frames(from, 'attach', null, 'lan').length, 0);
  assert.equal(c.frames(from, 'detach', null, 'lan').length, 0);
  // Закъснял кадър на скрития по relay-а вече не стига до страницата.
  assert.equal(c.relay.gate.isAttached('content-compact'), false);
  await waitFor(() => c.relay.state.caps, 'caps по LAN');
  c.host.open('content-compact');
  await waitFor(() => c.attachedFor('content-compact') === 2, 'attached по LAN при връщане');
  const lan = c.frames(from, 'attach', 'content-compact', 'lan');
  assert.equal(lan.length, 1);
  assert.ok(lan[0].includes('"keep":true'));
  assert.equal(c.frames(from, 'attach', 'content-compact').length, 0, 'attach по relay-а');
  // Обратно на relay-а (LAN пада): за паднал сокет detach не тръгва.
  const back = c.mark();
  c.host.input(b64('mock-lan-off\r'), 'content-compact');
  await waitFor(() => c.relay.state.path === 'relay', 'relay път');
  await waitFor(() => c.attachedFor('content-compact') === 3, 'attached по relay-а');
  await pause(300);
  assert.equal(c.frames(back, 'detach').length, 0);
  assert.equal(c.frames(back, 'detach', null, 'lan').length, 0);
});
