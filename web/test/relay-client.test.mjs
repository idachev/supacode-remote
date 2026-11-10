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
  c.host.input(Buffer.from('echo web-$((40+2))\r').toString('base64'), c.host.openContentId);
  await waitFor(() => c.text('content-shell-main').includes('web-42'), 'ехото на командата');
  // Вход за друг таб (закъснял Enter след смяна) не тръгва.
  assert.equal(c.host.input(Buffer.from('\r').toString('base64'), 'content-idle'), false);
  c.stop();
});

test('LAN пада — обратно на relay-а и нов attach сам', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.path === 'lan', 'LAN път');
  c.host.open('content-idle');
  await waitFor(() => c.messages.filter((m) => m.t === 'attached').length === 1, 'първи attached');
  const session = c.relay.state.hostSession;
  c.host.input(Buffer.from('mock-lan-off\r').toString('base64'), c.host.openContentId);
  await waitFor(() => c.relay.state.path === 'relay', 'relay път');
  assert.ok(c.relay.state.hostSession > session);
  await waitFor(() => c.messages.filter((m) => m.t === 'attached').length === 2, 'attached по relay-а');
  c.host.input(Buffer.from('mock-lan-on\r').toString('base64'), c.host.openContentId);
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
    c.host.input(Buffer.from('mock-lan-off\r').toString('base64'), c.host.openContentId);
    await waitFor(() => c.relay.state.path === 'relay', 'relay път');
  }
  const before = c.messages.filter((m) => m.t === 'attached').length;
  c.host.input(Buffer.from('mock-offline\r').toString('base64'), c.host.openContentId);
  await waitFor(() => !c.relay.state.hostOnline, 'офлайн');
  assert.equal(c.relay.state.hostSession, null);
  await waitFor(() => c.relay.state.hostOnline, 'пак онлайн', 10_000);
  await waitFor(() => c.messages.filter((m) => m.t === 'attached').length > before, 'нов attached');
  c.host.input(Buffer.from('mock-lan-on\r').toString('base64'), c.host.openContentId);
  c.stop();
});

test('нов таб с размера на прозореца', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostSession != null, 'сесия');
  c.host.newTab({ worktreeId: 'wt-main', cols: 90, rows: 30, ref: 'r1' });
  const reply = await waitFor(() => c.messages.find((m) => m.t === 'tab.new'), 'tab.new');
  assert.equal(reply.ref, 'r1');
  assert.equal(reply.worktreeId, 'wt-main');
  c.host.open(reply.contentId);
  const attached = await waitFor(() => c.messages.find((m) => m.t === 'attached'), 'attached');
  assert.deepEqual([attached.cols, attached.rows], [90, 30]);
  // Новият таб е в следващия list.
  await waitFor(() => c.messages.some((m) => m.t === 'list' &&
    m.repos.some((r) => r.worktrees.some((w) => w.tabs.some((t) => t.contentId === reply.contentId)))), 'табът в list');
  c.host.newTab({ worktreeId: 'wt-missing', cols: 90, rows: 30, ref: 'r2' });
  const err = await waitFor(() => c.messages.find((m) => m.t === 'error' && m.ref === 'r2'), 'грешка');
  assert.match(err.message, /unknown worktree/);
  c.stop();
});

test('нов worktree: първият таб с размера на прозореца, после в list и под repository-то', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostSession != null, 'сесия');
  const list = await waitFor(() => c.messages.find((m) => m.t === 'list'), 'list');
  assert.equal(list.repos.find((r) => r.id === 'repo-supacode').canCreateWorktree, true);
  assert.equal(list.repos.find((r) => r.id === 'repo-notes').canCreateWorktree, false);
  c.host.newWorktree({ repositoryId: 'repo-supacode', name: '  wt-web-test  ', cols: 88, rows: 28, ref: 'w1' });
  const reply = await waitFor(() => c.messages.find((m) => m.t === 'worktree.new'), 'worktree.new', 5_000);
  assert.equal(reply.ref, 'w1');
  assert.equal(reply.name, 'wt-web-test');
  assert.ok(reply.contentId);
  c.host.open(reply.contentId);
  const attached = await waitFor(() => c.messages.find((m) => m.t === 'attached'), 'attached');
  assert.deepEqual([attached.cols, attached.rows], [88, 28]);
  await waitFor(() => c.messages.some((m) => m.t === 'list' &&
    m.repos.some((r) => r.id === 'repo-supacode' && r.rowIds?.includes(reply.worktreeId) &&
      r.worktrees.some((w) => w.id === reply.worktreeId))), 'worktree-то в list');
  c.stop();
});

test('нов worktree: грешките на Mac-а идват с ref-а и кода', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostSession != null, 'сесия');
  const errorFor = (ref) => waitFor(() => c.messages.find((m) => m.t === 'error' && m.ref === ref), `грешка ${ref}`, 6_000);
  c.host.newWorktree({ repositoryId: 'repo-supacode', name: 'main', ref: 'e1' });
  assert.equal((await errorFor('e1')).code, 'worktree_failed');
  c.host.newWorktree({ repositoryId: 'repo-notes', name: 'x', ref: 'e2' });
  assert.equal((await errorFor('e2')).code, 'worktree_unsupported');
  c.host.newWorktree({ repositoryId: 'repo-missing', name: 'x', ref: 'e3' });
  assert.equal((await errorFor('e3')).code, 'worktree_invalid');
  // Празно име не тръгва към Mac-а.
  c.host.newWorktree({ repositoryId: 'repo-supacode', name: '   ', ref: 'e4' });
  assert.equal((await errorFor('e4')).code, 'worktree_invalid');
  c.host.newWorktree({ repositoryId: 'repo-supacode', name: 'mock-notab-1', ref: 'e5' });
  const noTab = await waitFor(() => c.messages.find((m) => m.t === 'worktree.new' && m.ref === 'e5'), 'без таб', 5_000);
  assert.equal(noTab.contentId, null);
  c.stop();
});

test('нов worktree: смяна на пътя — отговорът няма да дойде, страницата го знае веднага', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostSession != null && c.relay.state.path === 'lan', 'LAN сесия', 10_000);
  c.host.newWorktree({ repositoryId: 'repo-supacode', name: 'mock-slow-path', ref: 'p1' });
  c.host.open('content-shell-main');
  await waitFor(() => c.messages.some((m) => m.t === 'attached'), 'attached');
  c.host.input(Buffer.from('mock-lan-off\r').toString('base64'), 'content-shell-main');
  const lost = await waitFor(() => c.messages.find((m) => m.t === 'error' && m.ref === 'p1'), 'изгубен отговор', 6_000);
  assert.equal(lost.code, 'worktree_lost');
  await waitFor(() => c.messages.filter((m) => m.t === 'attached').length === 2, 'attached по relay-а');
  c.host.input(Buffer.from('mock-lan-on\r').toString('base64'), c.host.openContentId);
  await waitFor(() => c.relay.state.path === 'lan', 'пак LAN', 10_000);
  c.stop();
});

test('изтриване на worktree: основният не може, dirty отказва, иначе изчезва от list (ЗД13)', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostSession != null, 'сесия');
  const list = await waitFor(() => c.messages.find((m) => m.t === 'list'), 'list');
  assert.equal(list.canRefreshWorktrees, true);
  const supacode = list.repos.find((r) => r.id === 'repo-supacode');
  assert.equal(supacode.worktrees.find((w) => w.id === 'wt-main').canDeleteWorktree, false);
  assert.equal(supacode.worktrees.find((w) => w.id === 'wt-picker').canDeleteWorktree, true);
  const errorFor = (ref) => waitFor(() => c.messages.find((m) => m.t === 'error' && m.ref === ref), `грешка ${ref}`, 4_000);
  c.host.deleteWorktree({ worktreeId: 'wt-main', ref: 'd1' });
  assert.equal((await errorFor('d1')).code, 'worktree_unsupported');
  c.host.deleteWorktree({ worktreeId: 'wt-missing', ref: 'd2' });
  assert.equal((await errorFor('d2')).code, 'worktree_invalid');
  // Нов worktree с „dirty“ в името: mock-ът казва, че има незаписани промени.
  c.host.newWorktree({ repositoryId: 'repo-supacode', name: 'dirty-del', ref: 'n1' });
  const dirty = await waitFor(() => c.messages.find((m) => m.t === 'worktree.new' && m.ref === 'n1'), 'dirty-del', 5_000);
  c.host.deleteWorktree({ worktreeId: dirty.worktreeId, ref: 'd3' });
  const dirtyErr = await errorFor('d3');
  assert.equal(dirtyErr.code, 'worktree_dirty');
  assert.match(dirtyErr.message, /notes\.txt/);
  c.host.newWorktree({ repositoryId: 'repo-supacode', name: 'to-delete', ref: 'n2' });
  const created = await waitFor(() => c.messages.find((m) => m.t === 'worktree.new' && m.ref === 'n2'), 'to-delete', 5_000);
  c.host.open(created.contentId);
  await waitFor(() => c.messages.some((m) => m.t === 'attached' && m.contentId === created.contentId), 'attached');
  c.host.deleteWorktree({ worktreeId: created.worktreeId, ref: 'd4' });
  const done = await waitFor(() => c.messages.find((m) => m.t === 'worktree.delete' && m.ref === 'd4'), 'изтрито', 5_000);
  assert.equal(done.repositoryId, 'repo-supacode');
  await waitFor(() => c.messages.some((m) => m.t === 'detached' && m.contentId === created.contentId), 'detached', 5_000);
  await waitFor(() => c.messages.some((m) => m.t === 'list' &&
    !m.repos.some((r) => r.worktrees.some((w) => w.id === created.worktreeId)) &&
    !m.repos.some((r) => r.rowIds?.includes(created.worktreeId))), 'вече го няма в list');
  c.stop();
});

test('„Опресни“: list със същото id приключва чакането (ЗД13)', async () => {
  const c = connect();
  c.host.setActive(true);
  await waitFor(() => c.relay.state.hostSession != null, 'сесия');
  const before = c.messages.filter((m) => m.t === 'list').length;
  c.host.refreshWorktrees({ ref: 'r9' });
  const done = await waitFor(() => c.messages.find((m) => m.t === 'worktrees.refresh' && m.ref === 'r9'), 'опреснено', 3_000);
  assert.equal(done.kind, 'worktrees.refresh');
  assert.ok(c.messages.filter((m) => m.t === 'list').length > before);
  assert.equal(c.host.pending.size, 0);
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

test('невалиден адрес на relay-а — чакане с причина, процесът живее', async () => {
  const relay = new RelayClient();
  relay.configure({ baseUrl: 'https://example.com:bad', apiKey: 'k' });
  assert.equal(relay.state.connection, 'waiting');
  assert.equal(relay.state.reason, 'невалиден адрес');
  relay.stop();
});

test('ред от полето: Enter след 150 ms, а след смяна на пътя — без Enter', async () => {
  const c = connect();
  try {
  c.host.setActive(true);
  await waitFor(() => c.relay.state.path === 'lan', 'LAN път');
  c.host.open('content-compact');
  await waitFor(() => c.messages.some((m) => m.t === 'attached'), 'attached');
  assert.equal(c.host.line('echo line-$((1+2))', 'content-compact'), true);
  await waitFor(() => c.text('content-compact').includes('line-3'), 'изпълненият ред');
  // Другият таб не получава нищо.
  assert.equal(c.host.line('echo x', 'content-idle'), false);

  const before = mock.log().length;
  assert.equal(c.host.line('echo never-$((2+3))', 'content-compact'), true);
  // LAN пада веднага след текста (сокетът изчезва отдолу): нова сесия по relay-а преди Enter.
  c.relay.lan.ws.terminate();
  await waitFor(() => c.relay.state.path === 'relay', 'relay път');
  await new Promise((r) => setTimeout(r, 400));
  const after = mock.log().slice(before).split('\n').filter((l) => l.includes('input received,') && l.includes('content: content-compact,'));
  assert.ok(!after.some((l) => l.includes('hex: 0d')), `Enter тръгна след смяната:\n${after.join('\n')}`);
  assert.ok(!c.text('content-compact').includes('never-5'));
  } finally {
    c.stop();
  }
});

test('размер по екрана: само за отворения таб, host-ът ограничава и отговаря със size', async () => {
  const c = connect();
  try {
    c.host.setActive(true);
    await waitFor(() => c.relay.state.hostSession != null, 'сесия');
    c.host.open('content-notes');
    // Преди `attached` host-ът още не знае таба по тази връзка.
    assert.equal(c.host.resize({ contentId: 'content-notes', cols: 150, rows: 45 }), false);
    await waitFor(() => c.messages.some((m) => m.t === 'attached'), 'attached');
    assert.equal(c.host.resize({ contentId: 'content-idle', cols: 150, rows: 45 }), false);
    assert.equal(c.host.resize({ contentId: 'content-notes', cols: 150.5, rows: 45 }), false);
    assert.equal(c.host.resize({ contentId: 'content-notes', cols: 150, rows: 45 }), true);
    const size = await waitFor(() => c.messages.find((m) => m.t === 'size'), 'size');
    assert.deepEqual([size.cols, size.rows], [150, 45]);
    // Същият размер пак: по договора host-ът пак отговаря със `size`, за да не чака страницата.
    c.host.resize({ contentId: 'content-notes', cols: 150, rows: 45 });
    await waitFor(() => c.messages.filter((m) => m.t === 'size').length === 2, 'втори size');
    assert.deepEqual(c.messages.filter((m) => m.t === 'size').map((m) => [m.cols, m.rows]), [[150, 45], [150, 45]]);
    c.host.resize({ contentId: 'content-notes', cols: 9999, rows: 1 });
    await waitFor(() => c.messages.some((m) => m.t === 'size' && m.cols === 500 && m.rows === 5), 'ограничен size');
  } finally {
    c.stop();
  }
});

