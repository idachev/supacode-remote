// HostController с `watch` и живите терминали (`attach keep`, ДЗ5, ДЗ7–ДЗ12, ДЗ22) срещу mock-а.
// Mock-ът е без LAN: смяната на пътя е нова сесия и би сложила attach-ове, които тук не се гледат.
// Броят се кадрите в лога на mock-а („message received … type: attach“), а `list` — по
// изпратеното от `RelayClient`, защото mock-ът не пише `list` в лога.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient } from '../src/relay-client.mjs';
import { HostController } from '../src/host-controller.mjs';
import { startMock, waitFor } from './helpers/mock.mjs';
import { connect as rawConnect } from './helpers/mock-client.mjs';

let mock;
before(async () => { mock = await startMock({ lan: false }); });
after(async () => { await mock?.stop(); });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function client(t, target = mock, { hostId = null, ...options } = {}) {
  const relay = new RelayClient();
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
  const frames = (from, type, contentId = null) => target.log().slice(from).split('\n')
    .filter((l) => l.includes('message received, endpoint: client, type: ' + type + ',') &&
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
