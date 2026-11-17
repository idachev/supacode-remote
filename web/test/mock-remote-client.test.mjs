// Mock-ът говори новите съобщения на отдалечения клиент в Supacode (branch `remote-client-host`,
// docs/remote-access-protocol.md): `caps`, `attach keep`, `layout`, `watch`, `tab.close`,
// `pane.split`, `pane.close`, `tab.new paneId`. Без `resize hold`: още не е в host-а.
// Суров WebSocket клиент, без `RelayClient`: тестът проверява самите кадри.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMock, waitFor } from './helpers/mock.mjs';

let mock;
before(async () => { mock = await startMock(); });
after(async () => { await mock?.stop(); });

let nextId = 100;

async function connect(target = mock, hostId = null) {
  const query = hostId ? `?host=${hostId}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${target.port}/client${query}`, { headers: { Authorization: `Bearer ${target.key}` } });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch { /* ping/pong */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitFor(() => frames.some((f) => f.t === 'relay' && f.hostOnline), 'relay hostOnline');
  const client = {
    ws, frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** Праща заявка с ново id и чака отговора с това id (или `error`). */
    async request(msg) {
      const id = nextId++;
      client.send({ ...msg, id });
      await waitFor(() => frames.some((f) => f.id === id), `отговор на ${msg.t}`);
      return frames.find((f) => f.id === id);
    },
    framesAfter: (mark) => frames.slice(mark),
    close: () => ws.close(),
  };
  return client;
}

const allWorktrees = (list) => list.repos.flatMap((r) => r.worktrees);
const worktreeOf = (list, worktreeId) => allWorktrees(list).find((w) => w.id === worktreeId);

async function firstWorktreeWithTabs(c) {
  const list = await c.request({ t: 'list' });
  const worktree = allWorktrees(list).find((w) => w.tabs.length > 0);
  return { list, worktree };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('hello има caps без resize.hold', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  c.send({ t: 'hello', v: 1 });
  await waitFor(() => c.frames.some((f) => f.t === 'hello'), 'hello');
  const hello = c.frames.find((f) => f.t === 'hello');
  assert.deepEqual(hello.caps, ['attach.keep', 'watch', 'layout', 'tab.close', 'pane.split', 'pane.close']);
});

test('всеки worktree с табове има layout с един pane и всичките му табове', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { list } = await firstWorktreeWithTabs(c);
  for (const w of allWorktrees(list)) {
    if (w.tabs.length === 0) {
      assert.equal(w.layout, undefined, `${w.id} без табове е без layout`);
      continue;
    }
    const [pane] = w.layout.panes;
    assert.equal(w.layout.mode, 'tabsPerSplit');
    assert.equal(w.layout.activeGroupId, 'main');
    assert.deepEqual(w.layout.groups.map((g) => g.id), ['main']);
    assert.deepEqual(w.layout.groups[0].tree, { pane: pane.id });
    assert.deepEqual(pane.tabIds, w.tabs.map((tab) => tab.id));
  }
});

test('attach с keep държи два таба, а без keep откача другите', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const tabs = (await c.request({ t: 'tab.new', worktreeId: worktree.id }));
  const a = worktree.tabs[0].contentId;
  const b = tabs.contentId;
  await c.request({ t: 'attach', contentId: a, scrollback: 0 });
  await c.request({ t: 'attach', contentId: b, scrollback: 0, keep: true });
  c.send({ t: 'resize', contentId: a, cols: 91, rows: 31 });
  await waitFor(() => c.frames.some((f) => f.t === 'size' && f.contentId === a && f.cols === 91), 'size за първия таб (още е закачен)');

  await c.request({ t: 'attach', contentId: b, scrollback: 0 });
  const mark = c.frames.length;
  c.send({ t: 'resize', contentId: a, cols: 92, rows: 32 });
  c.send({ t: 'resize', contentId: b, cols: 93, rows: 33 });
  await waitFor(() => c.framesAfter(mark).some((f) => f.t === 'size' && f.contentId === b && f.cols === 93), 'size за втория таб');
  assert.equal(c.framesAfter(mark).some((f) => f.t === 'size' && f.contentId === a), false, 'attach без keep откача първия');
});

test('detach спира само своя таб', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const b = (await c.request({ t: 'tab.new', worktreeId: worktree.id })).contentId;
  const a = worktree.tabs[0].contentId;
  await c.request({ t: 'attach', contentId: a, scrollback: 0 });
  await c.request({ t: 'attach', contentId: b, scrollback: 0, keep: true });
  c.send({ t: 'resize', contentId: a, cols: 95, rows: 35 });
  await waitFor(() => c.frames.some((f) => f.t === 'size' && f.contentId === a && f.cols === 95), 'първият таб е закачен преди detach');
  c.send({ t: 'detach', contentId: a });
  const mark = c.frames.length;
  c.send({ t: 'resize', contentId: a, cols: 96, rows: 36 });
  c.send({ t: 'resize', contentId: b, cols: 94, rows: 34 });
  await waitFor(() => c.framesAfter(mark).some((f) => f.t === 'size' && f.contentId === b && f.cols === 94), 'вторият таб остава закачен');
  assert.equal(c.framesAfter(mark).some((f) => f.t === 'size' && f.contentId === a), false, 'първият е откачен');
});

test('седемнайстият attach с keep получава attach_limit и не променя нищо', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const contents = [];
  for (let i = 0; i < 17; i += 1) contents.push((await c.request({ t: 'tab.new', worktreeId: worktree.id })).contentId);
  for (const contentId of contents.slice(0, 16)) {
    const reply = await c.request({ t: 'attach', contentId, scrollback: 0, keep: true });
    assert.equal(reply.t, 'attached');
  }
  const refused = await c.request({ t: 'attach', contentId: contents[16], scrollback: 0, keep: true });
  assert.deepEqual([refused.t, refused.code, refused.contentId], ['error', 'attach_limit', contents[16]]);
  assert.equal(refused.message, 'too many attached terminals');
  const again = await c.request({ t: 'attach', contentId: contents[0], scrollback: 0, keep: true });
  assert.equal(again.t, 'attached', 'повторен attach на вече закачен таб не е нов');
});

test('pane.split добавя pane с нов таб, а tab.new с paneId слага таба в него', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const first = worktree.layout.panes[0].id;
  const split = await c.request({ t: 'pane.split', paneId: first, direction: 'vertical' });
  assert.equal(split.t, 'pane.split');
  assert.equal(split.worktreeId, worktree.id);
  assert.ok(split.paneId && split.tabId && split.contentId);
  const attached = await c.request({ t: 'attach', contentId: split.contentId, scrollback: 0 });
  assert.equal(attached.t, 'attached');

  const added = await c.request({ t: 'tab.new', worktreeId: worktree.id, paneId: first });
  const layout = worktreeOf(await c.request({ t: 'list' }), worktree.id).layout;
  assert.deepEqual(layout.groups[0].tree, { split: { direction: 'vertical', ratio: 0.5, left: { pane: first }, right: { pane: split.paneId } } });
  assert.ok(layout.panes.find((p) => p.id === first).tabIds.includes(added.tabId));
  assert.deepEqual(layout.panes.find((p) => p.id === split.paneId).tabIds, [split.tabId]);
});

test('pane.split и pane.close с грешни данни връщат pane_invalid', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const pane = worktree.layout.panes[0].id;
  const cases = [
    [{ t: 'pane.split', direction: 'vertical' }, 'pane.split needs a paneId'],
    [{ t: 'pane.split', paneId: 'pane-none', direction: 'vertical' }, 'no such pane'],
    [{ t: 'pane.split', paneId: pane, direction: 'up' }, 'direction must be horizontal or vertical'],
    [{ t: 'pane.close' }, 'pane.close needs a paneId'],
    [{ t: 'pane.close', paneId: 'pane-none' }, 'no such pane'],
  ];
  for (const [msg, message] of cases) {
    const reply = await c.request(msg);
    assert.deepEqual([reply.t, reply.code, reply.message], ['error', 'pane_invalid', message], JSON.stringify(msg));
  }
});

test('tab.close затваря таба, а закаченият получава detached', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const tab = await c.request({ t: 'tab.new', worktreeId: worktree.id });
  await c.request({ t: 'attach', contentId: tab.contentId, scrollback: 0 });
  const closed = await c.request({ t: 'tab.close', tabId: tab.tabId });
  assert.deepEqual(closed, { t: 'tab.close', id: closed.id, tabId: tab.tabId, worktreeId: worktree.id });
  await waitFor(() => c.frames.some((f) => f.t === 'detached' && f.contentId === tab.contentId), 'detached');
  const after = worktreeOf(await c.request({ t: 'list' }), worktree.id);
  assert.equal(after.tabs.some((x) => x.id === tab.tabId), false);
  assert.equal(after.layout.panes.some((p) => p.tabIds.includes(tab.tabId)), false);
  const missing = await c.request({ t: 'tab.close', tabId: tab.tabId });
  assert.deepEqual([missing.code, missing.message], ['tab_invalid', 'no such tab']);
  const noId = await c.request({ t: 'tab.close' });
  assert.deepEqual([noId.code, noId.message], ['tab_invalid', 'tab.close needs a tabId']);
});

test('pane.close затваря всичките му табове и pane-ът изчезва', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const split = await c.request({ t: 'pane.split', paneId: worktree.layout.panes[0].id, direction: 'horizontal' });
  await c.request({ t: 'tab.new', worktreeId: worktree.id, paneId: split.paneId });
  const closed = await c.request({ t: 'pane.close', paneId: split.paneId });
  assert.deepEqual(closed, { t: 'pane.close', id: closed.id, paneId: split.paneId, worktreeId: worktree.id });
  const layout = worktreeOf(await c.request({ t: 'list' }), worktree.id).layout;
  assert.equal(layout.panes.some((p) => p.id === split.paneId), false);
  assert.equal(JSON.stringify(layout.groups[0].tree).includes(split.paneId), false);
});

test('watch праща list с id null при промяна, а watch off спира', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const reply = await c.request({ t: 'watch', on: true });
  assert.deepEqual([reply.t, reply.on], ['watch', true]);
  const tab = await c.request({ t: 'tab.new', worktreeId: worktree.id });
  const pushed = () => c.frames.filter((f) => f.t === 'list' && f.id === null);
  await waitFor(() => pushed().some((l) => worktreeOf(l, worktree.id).tabs.some((x) => x.id === tab.tabId)), 'list с новия таб');

  await c.request({ t: 'watch', on: false });
  await pause(300);
  const count = pushed().length;
  await c.request({ t: 'tab.new', worktreeId: worktree.id });
  await pause(600);
  assert.equal(pushed().length, count, 'след watch off няма list');
});

test('без промяна watch не праща нищо', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  await c.request({ t: 'list' });
  await c.request({ t: 'watch', on: true });
  await pause(700);
  assert.equal(c.frames.filter((f) => f.t === 'list' && f.id === null).length, 0);
});

// Ревю F1: Mac-ът затваря таба, когато shell-ът му свърши (`exit`).
test('exit в shell-а затваря таба', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const tab = await c.request({ t: 'tab.new', worktreeId: worktree.id });
  await c.request({ t: 'attach', contentId: tab.contentId, scrollback: 0 });
  c.send({ t: 'input', contentId: tab.contentId, b64: Buffer.from('exit\r').toString('base64') });
  await waitFor(() => c.frames.some((f) => f.t === 'detached' && f.contentId === tab.contentId), 'detached');
  const after = worktreeOf(await c.request({ t: 'list' }), worktree.id);
  assert.equal(after.tabs.some((x) => x.id === tab.tabId), false);
  const again = await c.request({ t: 'attach', contentId: tab.contentId, scrollback: 0 });
  assert.equal(again.t, 'error');
});

// Ревю F3: строгите полета с грешен тип спират кадъра без отговор, в каквото и да е съобщение.
test('строги полета с грешен тип спират кадъра без отговор', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  await c.request({ t: 'list' });
  await c.request({ t: 'watch', on: true });
  const dropped = [
    { t: 'watch', on: 'false' },
    { t: 'tab.close', tabId: 5 },
    { t: 'pane.close', paneId: 123 },
    { t: 'attach', contentId: worktree.tabs[0].contentId, keep: 'yes' },
    { t: 'tab.new', worktreeId: worktree.id, paneId: 7 },
    { t: 'list', hold: 1 },
  ];
  const ids = dropped.map((msg) => { const id = nextId++; c.send({ ...msg, id }); return id; });
  const tab = await c.request({ t: 'tab.new', worktreeId: worktree.id });
  await waitFor(() => c.frames.some((f) => f.t === 'list' && f.id === null && worktreeOf(f, worktree.id).tabs.some((x) => x.id === tab.tabId)),
    'watch още тече: `on:"false"` е пропуснат');
  assert.deepEqual(c.frames.filter((f) => ids.includes(f.id)), []);
});

// Ревю F5: новият host отговаря на `list` без `id` с `id:null`.
test('list без id получава id null', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  c.send({ t: 'list' });
  await waitFor(() => c.frames.some((f) => f.t === 'list'), 'list');
  assert.equal(Object.hasOwn(c.frames.find((f) => f.t === 'list'), 'id'), true);
  assert.equal(c.frames.find((f) => f.t === 'list').id, null);
});

// Ревю F2: Mac-ът, който е бил извън линия, вижда нова връзка: `watch` трябва да се прати наново.
test('watch свършва, когато Mac-ът излезе от линия', async (t) => {
  const c = await connect();
  t.after(() => c.close());
  const { worktree } = await firstWorktreeWithTabs(c);
  const tab = await c.request({ t: 'tab.new', worktreeId: worktree.id });
  await c.request({ t: 'attach', contentId: tab.contentId, scrollback: 0 });
  await c.request({ t: 'watch', on: true });
  const mark = c.frames.length;
  c.send({ t: 'input', contentId: tab.contentId, b64: Buffer.from('mock-offline\r').toString('base64') });
  await waitFor(() => c.framesAfter(mark).some((f) => f.t === 'relay' && !f.hostOnline), 'Mac извън линия');
  await waitFor(() => c.framesAfter(mark).some((f) => f.t === 'relay' && f.hostOnline), 'Mac пак на линия', 10_000);
  const back = c.frames.length;
  await c.request({ t: 'tab.new', worktreeId: worktree.id });
  await pause(700);
  assert.equal(c.framesAfter(back).some((f) => f.t === 'list' && f.id === null), false);
});

// Ревю F4: старият host не знае `paneId` и го пренебрегва, без да спира кадъра.
test('старият host пренебрегва paneId от грешен тип', async (t) => {
  const legacy = await startMock({ lan: false, env: { MOCK_SINGLE_HOST: '0', MOCK_OLD_RELAY: '0', MOCK_LEGACY: '1' } });
  t.after(() => legacy.stop());
  const c = await connect(legacy, 'default');
  t.after(() => c.close());
  const list = await c.request({ t: 'list' });
  const worktree = allWorktrees(list)[0];
  assert.equal(worktree.layout, undefined);
  const reply = await c.request({ t: 'tab.new', worktreeId: worktree.id, paneId: 7 });
  assert.equal(reply.t, 'tab.new');
});
