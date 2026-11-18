// `resize` с `hold:true` в mock-а (раздел „resize“ в протокола на branch `remote-client-host`).
// Решения на 3amigos (2026-11-18): истински срок без собственик (тук скъсен с MOCK_HOLD_GRACE_MS),
// Ctrl+L само за таб с агент, а при край без по-нов resize размерът се връща към този на Mac-а.
// Собствен mock: срокът е скъсен, а таймерите от тук не бива да стигат до другите тестове.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, waitFor } from './helpers/mock.mjs';
import { allWorktrees, connect, pause } from './helpers/mock-client.mjs';

const GRACE_MS = 800;
let mock;
before(async () => { mock = await startMock({ env: { MOCK_HOLD_GRACE_MS: String(GRACE_MS) } }); });
after(async () => { await mock?.stop(); });

const sizes = (c, contentId, mark = 0) => c.framesAfter(mark).filter((f) => f.t === 'size' && f.contentId === contentId);
const hasSize = (c, contentId, cols, rows, mark = 0) => sizes(c, contentId, mark).some((f) => f.cols === cols && f.rows === rows);

/** Двама клиенти, закачени за нов таб: `owner` ще задържи размера, `other` гледа. */
async function setup(t) {
  const owner = await connect(mock);
  const other = await connect(mock);
  t.after(() => { owner.close(); other.close(); });
  const list = await owner.request({ t: 'list' });
  const worktree = allWorktrees(list).find((w) => w.tabs.length > 0);
  const tab = await owner.request({ t: 'tab.new', worktreeId: worktree.id });
  await owner.request({ t: 'attach', contentId: tab.contentId, scrollback: 0 });
  await other.request({ t: 'attach', contentId: tab.contentId, scrollback: 0 });
  return { owner, other, worktree, tab, contentId: tab.contentId };
}

async function hold(c, contentId, cols, rows) {
  const mark = c.frames.length;
  c.send({ t: 'resize', contentId, cols, rows, hold: true });
  await waitFor(() => hasSize(c, contentId, cols, rows, mark), `size ${cols}×${rows}`);
}

test('hold сменя размера и праща Ctrl+L само на таб с агент', async (t) => {
  const { owner, other, contentId } = await setup(t);
  const from = mock.log().length;
  await hold(owner, contentId, 90, 30);
  await waitFor(() => hasSize(other, contentId, 90, 30), 'size и до другия клиент');
  assert.equal(mock.log().slice(from).includes(`ctrl-l sent, content: ${contentId}`), false, 'таб без агент — без Ctrl+L');

  const list = await owner.request({ t: 'list' });
  const agentTab = allWorktrees(list).flatMap((w) => w.tabs).find((x) => x.agents?.length > 0);
  await owner.request({ t: 'attach', contentId: agentTab.contentId, scrollback: 0 });
  const fromAgent = mock.log().length;
  await hold(owner, agentTab.contentId, 92, 32);
  await waitFor(() => mock.log().slice(fromAgent).includes(`ctrl-l sent, content: ${agentTab.contentId}`), 'Ctrl+L за таба с агент');
  owner.send({ t: 'detach', contentId: agentTab.contentId });
});

test('обикновен resize по време на задържане го прекратява без връщане', async (t) => {
  const { owner, other, contentId } = await setup(t);
  await hold(owner, contentId, 90, 30);
  other.send({ t: 'resize', contentId, cols: 91, rows: 31 });
  await waitFor(() => hasSize(owner, contentId, 91, 31), 'новият размер');
  const mark = other.frames.length;
  owner.send({ t: 'detach', contentId });
  await pause(400);
  assert.deepEqual(sizes(other, contentId, mark), [], 'задържането вече е свършило: detach не връща нищо');
});

test('detach на собственика връща размера на Mac-а към всички закачени', async (t) => {
  const { owner, other, contentId } = await setup(t);
  await hold(owner, contentId, 90, 30);
  owner.send({ t: 'detach', contentId });
  await waitFor(() => hasSize(other, contentId, 120, 40), 'size 120×40');
});

test('attach на друг таб без keep освобождава задържането', async (t) => {
  const { owner, other, worktree, contentId } = await setup(t);
  await hold(owner, contentId, 90, 30);
  const second = await owner.request({ t: 'tab.new', worktreeId: worktree.id });
  await owner.request({ t: 'attach', contentId: second.contentId, scrollback: 0 });
  await waitFor(() => hasSize(other, contentId, 120, 40), 'size 120×40');
});

test('повторен attach на задържания таб го запазва', async (t) => {
  const { owner, other, contentId } = await setup(t);
  await hold(owner, contentId, 90, 30);
  const mark = other.frames.length;
  await owner.request({ t: 'attach', contentId, scrollback: 0 });
  await pause(300);
  assert.equal(hasSize(other, contentId, 120, 40, mark), false, 'повторният attach не освобождава');
  owner.send({ t: 'detach', contentId });
  await waitFor(() => hasSize(other, contentId, 120, 40, mark), 'задържането още е било тук');
});

test('паднала връзка: задържането свършва след срока без собственик', async (t) => {
  const { owner, other, contentId } = await setup(t);
  await hold(owner, contentId, 90, 30);
  const mark = other.frames.length;
  owner.close();
  await pause(GRACE_MS / 2);
  assert.equal(hasSize(other, contentId, 120, 40, mark), false, 'в срока размерът стои');
  await waitFor(() => hasSize(other, contentId, 120, 40, mark), 'след срока — 120×40');
});

test('held resize в срока поема задържането', async (t) => {
  const { owner, other, contentId } = await setup(t);
  await hold(owner, contentId, 90, 30);
  owner.close();
  await pause(GRACE_MS / 4);
  await hold(other, contentId, 90, 30);
  const mark = other.frames.length;
  await pause(GRACE_MS + 300);
  assert.equal(hasSize(other, contentId, 120, 40, mark), false, 'новият собственик държи размера');
  other.send({ t: 'detach', contentId });
});

test('mock-resize по време на задържане не мени PTY-то, а после размерът се връща към него', async (t) => {
  const { owner, other, contentId } = await setup(t);
  await hold(owner, contentId, 90, 30);
  const mark = other.frames.length;
  owner.send({ t: 'input', contentId, b64: Buffer.from('mock-resize\r').toString('base64') });
  await pause(400);
  assert.equal(hasSize(other, contentId, 100, 30, mark), false, 'задържаният размер не се мени');
  owner.send({ t: 'detach', contentId });
  await waitFor(() => hasSize(other, contentId, 100, 30, mark), 'размерът на Mac-а след mock-resize');
});

test('resize_failed прекратява задържането', async (t) => {
  const { owner, other, contentId } = await setup(t);
  await hold(owner, contentId, 90, 30);
  owner.send({ t: 'input', contentId, b64: Buffer.from('mock-resize-fail\r').toString('base64') });
  await pause(300);
  const failed = await owner.request({ t: 'resize', contentId, cols: 95, rows: 35, hold: true });
  assert.equal(failed.code, 'resize_failed');
  const mark = other.frames.length;
  owner.send({ t: 'detach', contentId });
  await pause(400);
  assert.equal(hasSize(other, contentId, 120, 40, mark), false, 'след resize_failed няма задържане за освобождаване');
});
