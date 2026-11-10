// Mock-ът с няколко Mac-а (`MOCK_LEGACY=1`): всеки Mac има свои табове. Нов таб на единия не
// бива да се вижда в списъка на другия — там `attach` към него би върнал грешка.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMock } from './helpers/mock.mjs';

const HOME = '40be40be40be40be';
const LEGACY = 'default';

let mock;

before(async () => {
  mock = await startMock({ lan: false, env: { MOCK_SINGLE_HOST: '0', MOCK_OLD_RELAY: '0', MOCK_LEGACY: '1' } });
});

after(() => mock?.stop());

/** Клиент към един Mac: `request` праща съобщение с `id` и чака отговора със същото `id`. */
async function connect(hostId) {
  const ws = new WebSocket(`ws://127.0.0.1:${mock.port}/client?host=${hostId}`, { headers: { Authorization: `Bearer ${mock.key}` } });
  const waiting = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    waiting.get(msg.id)?.(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let next = 0;
  const request = (msg) => new Promise((resolve) => {
    next += 1;
    waiting.set(next, resolve);
    ws.send(JSON.stringify({ ...msg, id: next }));
  });
  return { ws, request };
}

const contentIds = (list) => list.repos.flatMap((r) => r.worktrees.flatMap((w) => w.tabs.map((t) => t.contentId)));

async function newTabOn(client) {
  const list = await client.request({ t: 'list' });
  const worktreeId = list.repos[0].worktrees[0].id;
  return (await client.request({ t: 'tab.new', worktreeId })).contentId;
}

test('нов таб на единия Mac не е в списъка на другия, а attach работи само при своя Mac', async () => {
  const home = await connect(HOME);
  const legacy = await connect(LEGACY);
  try {
    for (const [own, other] of [[legacy, home], [home, legacy]]) {
      const contentId = await newTabOn(own);
      assert.ok(contentIds(await own.request({ t: 'list' })).includes(contentId));
      assert.ok(!contentIds(await other.request({ t: 'list' })).includes(contentId));
      assert.equal((await own.request({ t: 'attach', contentId })).t, 'attached');
      assert.equal((await other.request({ t: 'attach', contentId })).t, 'error');
    }
  } finally {
    home.ws.close();
    legacy.ws.close();
  }
});
