// RelayClient и HostController срещу истинския mock (relay + Mac с истински shell-ове).
// Проверките са по кадрите на протокола, не по текста на shell-а, освен ехото на `input`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient } from '../src/relay-client.mjs';
import { HostController } from '../src/host-controller.mjs';
import { startMock, waitFor } from './helpers/mock.mjs';

let mock;
before(async () => { mock = await startMock(); });
after(async () => { await mock?.stop(); });

function connect(settings = mock.settings) {
  const relay = new RelayClient({ timing: { lanRetryFirstMs: 300, lanRetryMaxMs: 600 } });
  const host = new HostController(relay, { listIntervalMs: 60_000 });
  const messages = [];
  host.on('message', (m) => messages.push(m));
  relay.configure(settings);
  const text = (contentId) => messages
    .filter((m) => m.t === 'out' && m.contentId === contentId)
    .map((m) => Buffer.from(m.b64, 'base64').toString('utf8')).join('');
  return { relay, host, messages, text, stop: () => { host.setActive(false); relay.stop(); } };
}

test('грешен ключ — unauthorized и нов опит няма', async () => {
  const c = connect({ ...mock.settings, apiKey: 'wrong' });
  await waitFor(() => c.relay.state.connection === 'unauthorized', 'unauthorized');
  await new Promise((r) => setTimeout(r, 1_300));
  assert.equal(c.relay.state.connection, 'unauthorized');
  c.stop();
});

test('онлайн Mac — hello, LAN път, list и терминал с вход', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.path === 'lan', 'LAN път');
  assert.equal(c.relay.state.hostName, 'Mock Mac');
  assert.equal(c.relay.state.hostOnline, true);
  await waitFor(() => c.messages.some((m) => m.t === 'list' && m.repos.length === 3), 'list с 3 repo-та');

  c.host.open('content-shell-main');
  const attached = await waitFor(() => c.messages.find((m) => m.t === 'attached'), 'attached');
  assert.equal(attached.contentId, 'content-shell-main');
  assert.equal(attached.cols, 120);
  c.host.input(Buffer.from('echo web-$((40+2))\r').toString('base64'));
  await waitFor(() => c.text('content-shell-main').includes('web-42'), 'ехото на командата');
  c.stop();
});

test('LAN пада — обратно на relay-а и нов attach сам', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.path === 'lan', 'LAN път');
  c.host.open('content-idle');
  await waitFor(() => c.messages.filter((m) => m.t === 'attached').length === 1, 'първи attached');
  const session = c.relay.state.hostSession;
  c.host.input(Buffer.from('mock-lan-off\r').toString('base64'));
  await waitFor(() => c.relay.state.path === 'relay', 'relay път');
  assert.ok(c.relay.state.hostSession > session);
  await waitFor(() => c.messages.filter((m) => m.t === 'attached').length === 2, 'attached по relay-а');
  c.host.input(Buffer.from('mock-lan-on\r').toString('base64'));
  // Нов hello по relay-а носи пак `lan` и пътят се връща на LAN, с нов attach.
  await waitFor(() => c.relay.state.path === 'lan', 'пак LAN', 10_000);
  await waitFor(() => c.messages.filter((m) => m.t === 'attached').length === 3, 'attached по LAN');
  c.stop();
});

test('Mac-ът изчезва от relay-а и се връща — нов attach', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostOnline, 'онлайн');
  // mock-offline засяга само relay клиентите, затова LAN се спира първо.
  c.host.open('content-codex');
  await waitFor(() => c.messages.some((m) => m.t === 'attached'), 'attached');
  if (c.relay.state.path === 'lan') {
    c.host.input(Buffer.from('mock-lan-off\r').toString('base64'));
    await waitFor(() => c.relay.state.path === 'relay', 'relay път');
  }
  const before = c.messages.filter((m) => m.t === 'attached').length;
  c.host.input(Buffer.from('mock-offline\r').toString('base64'));
  await waitFor(() => !c.relay.state.hostOnline, 'офлайн');
  assert.equal(c.relay.state.hostSession, null);
  await waitFor(() => c.relay.state.hostOnline, 'пак онлайн', 10_000);
  await waitFor(() => c.messages.filter((m) => m.t === 'attached').length > before, 'нов attached');
  c.host.input(Buffer.from('mock-lan-on\r').toString('base64'));
  c.stop();
});

test('нов таб с размера на прозореца', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostSession != null, 'сесия');
  c.host.newTab('wt-main', 90, 30, 'r1');
  const reply = await waitFor(() => c.messages.find((m) => m.t === 'tab.new'), 'tab.new');
  assert.equal(reply.ref, 'r1');
  assert.equal(reply.worktreeId, 'wt-main');
  c.host.open(reply.contentId);
  const attached = await waitFor(() => c.messages.find((m) => m.t === 'attached'), 'attached');
  assert.deepEqual([attached.cols, attached.rows], [90, 30]);
  // Новият таб е в следващия list.
  await waitFor(() => c.messages.some((m) => m.t === 'list' &&
    m.repos.some((r) => r.worktrees.some((w) => w.tabs.some((t) => t.contentId === reply.contentId)))), 'табът в list');
  c.host.newTab('wt-missing', 90, 30, 'r2');
  const err = await waitFor(() => c.messages.find((m) => m.t === 'error' && m.ref === 'r2'), 'грешка');
  assert.match(err.message, /unknown worktree/);
  c.stop();
});

test('предложенията идват с ref-а на страницата', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostSession != null, 'сесия');
  c.host.open('content-shell-main');
  c.host.suggest('s1');
  const reply = await waitFor(() => c.messages.find((m) => m.t === 'suggest'), 'suggest', 6_000);
  assert.equal(reply.ref, 's1');
  assert.ok(reply.suggestions.length > 0);
  c.stop();
});
