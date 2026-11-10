// Чистите решения на екраните (`public/view-model.js`), пуснати в Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countAwaiting } from '../public/session-groups.js';
import { bannerFor, boundHost, hostLabel, nextWorktree, pageTitle, terminalStatusFor } from '../public/view-model.js';

const connected = { configured: true, connection: 'connected', path: 'lan', hosts: null };

test('лентата за връзката по състояние', () => {
  assert.equal(bannerFor(connected, false).text, 'Няма връзка с локалния сървър. Пусни web/run.sh и изчакай.');
  assert.equal(bannerFor({ configured: false }, true), null);
  assert.equal(bannerFor(connected, true), null);
  assert.deepEqual(bannerFor({ ...connected, connection: 'unauthorized' }, true), { text: 'Relay-ът не прие ключа (401). Провери го.', error: true });
  assert.equal(bannerFor({ ...connected, connection: 'connecting' }, true).text, 'Свързване с relay-а…');
  assert.deepEqual(bannerFor({ ...connected, connection: 'waiting', reason: 'HTTP 502', retryInMs: 3500 }, true),
    { text: 'Няма връзка: HTTP 502. Нов опит след 4 s', retry: true });
});

test('Mac извън линия: стар relay, без избор, с избран Mac', () => {
  const offline = { ...connected, path: 'none' };
  assert.equal(bannerFor(offline, true).text, 'Mac-ът е офлайн');
  assert.equal(bannerFor({ ...offline, hosts: [] }, true).text, 'Избери Mac');
  const hosts = [{ id: 'a', name: 'Office Mac', online: false }, { id: 'b', name: null, online: false }];
  assert.equal(bannerFor({ ...offline, hosts, selectedHostId: 'a' }, true).text, 'Office Mac е извън линия');
  assert.equal(bannerFor({ ...offline, hosts, selectedHostId: 'b' }, true).text, 'Mac без име е извън линия');
  assert.equal(bannerFor({ ...offline, hosts, selectedHostId: 'gone' }, true).text, 'Избраният Mac е извън линия');
});

test('избраният Mac и името му', () => {
  assert.equal(boundHost({ hosts: null, selectedHostId: 'a' }), null);
  assert.equal(boundHost({ hosts: [{ id: 'a', name: 'A' }], selectedHostId: 'a' }).name, 'A');
  assert.equal(hostLabel(null), 'Mac без име');
});

test('текстът върху терминала', () => {
  assert.equal(terminalStatusFor({ phase: 'live' }), null);
  assert.equal(terminalStatusFor({ phase: 'none' }).text, 'Избери таб отляво.');
  assert.equal(terminalStatusFor({ phase: 'opening', state: { hostSession: null } }).text, 'Чакам връзка с Mac-а…');
  assert.equal(terminalStatusFor({ phase: 'opening', state: { hostSession: 2 } }).text, 'Свързване с таба…');
  assert.deepEqual(terminalStatusFor({ phase: 'ended', endReason: 'session ended' }), { text: 'Потокът спря: session ended', retry: true });
});

test('заглавието на страницата носи броя чакащи', () => {
  const found = { tab: { title: 'claude' }, worktree: { name: 'w', title: 'Remote access' } };
  assert.equal(pageTitle({ found, state: {}, awaiting: 2 }), '(2) claude · Remote access');
  assert.equal(pageTitle({ found: null, state: { hostName: 'Mock Mac' }, awaiting: 0 }), 'Mock Mac');
  const list = { repos: [{ worktrees: [{ tabs: [{ agents: [{ activity: 'awaitingInput' }] }, { agents: [] }] }] }] };
  assert.equal(countAwaiting(list), 1);
  assert.equal(countAwaiting(null), 0);
});

test('следващият worktree прескача тези без табове и върви в кръг', () => {
  const row = (id, tabs) => ({ worktree: { id, tabs: Array.from({ length: tabs }, (_, i) => ({ contentId: `${id}-${i}` })) } });
  const order = [row('a', 1), row('b', 0), row('c', 2)];
  assert.equal(nextWorktree(order, 'a', 1).id, 'c');
  assert.equal(nextWorktree(order, 'c', 1).id, 'a');
  assert.equal(nextWorktree(order, 'a', -1).id, 'c');
  assert.equal(nextWorktree(order, null, 1).id, 'a');
  assert.equal(nextWorktree(order, null, -1).id, 'c');
  assert.equal(nextWorktree([row('x', 0)], null, 1), null);
  assert.equal(nextWorktree([row('only', 1)], 'only', -1).id, 'only');
});
