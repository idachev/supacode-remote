// `AttachSession` с фалшив host (unit) и с истинските `RelayClient` + `HostController` срещу mock-а.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AttachSession, CLEAR, RESTORE, sizeTitle } from '../src/attach-session.mjs';
import { HostController } from '../src/host-controller.mjs';
import { RelayClient } from '../src/relay-client.mjs';
import { listTabs } from '../src/attach-tabs.mjs';
import { startMock, waitFor } from './helpers/mock.mjs';

class FakeHost extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    for (const name of ['setActive', 'open', 'close', 'input', 'resize']) {
      this[name] = (...args) => { this.calls.push([name, ...args]); return true; };
    }
  }
}

const b64 = (s) => Buffer.from(s, 'binary').toString('base64');

function setup({ local = { cols: 100, rows: 30 } } = {}) {
  const host = new FakeHost();
  const chunks = [];
  const session = new AttachSession({ host, contentId: 'c1', write: (buf) => chunks.push(Buffer.from(buf)), localSize: () => local });
  const written = () => Buffer.concat(chunks).toString('binary');
  const exits = [];
  session.on('exit', (e) => exits.push(e));
  return { session, host, written, exits, clear: () => { chunks.length = 0; } };
}

const utf8 = (s) => Buffer.from(s, 'utf8').toString('binary');

test('start отваря таба', () => {
  const { session, host } = setup();
  session.start();
  assert.deepEqual(host.calls, [['setActive', true], ['open', 'c1']]);
});

test('attached чисти екрана и историята и пише заглавие с двата размера', () => {
  const { session, host, written } = setup();
  session.start();
  host.emit('message', { t: 'attached', contentId: 'c1', cols: 120, rows: 40 });
  assert.equal(written(), CLEAR + utf8('\x1b]2;Mac 120×40 · тук 100×30\x07'));
});

test('втори attached (нов път) пак чисти преди redraw-а', () => {
  const { session, host, written, clear } = setup();
  session.start();
  host.emit('message', { t: 'attached', contentId: 'c1', cols: 120, rows: 40 });
  host.emit('message', { t: 'out', contentId: 'c1', b64: b64('стар') });
  clear();
  host.emit('message', { t: 'attached', contentId: 'c1', cols: 120, rows: 40 });
  assert.ok(written().startsWith(CLEAR));
});

test('out минава през филтъра на въпросите', () => {
  const { session, host, written, clear } = setup();
  session.start();
  host.emit('message', { t: 'attached', contentId: 'c1', cols: 80, rows: 24 });
  clear();
  host.emit('message', { t: 'out', contentId: 'c1', b64: b64('a\x1b[6nb') });
  assert.equal(written(), 'ab');
});

test('кадри за друг таб се прескачат', () => {
  const { session, host, written } = setup();
  session.start();
  host.emit('message', { t: 'out', contentId: 'c2', b64: b64('x') });
  assert.equal(written(), '');
});

test('size сменя заглавието', () => {
  const { session, host, written, clear } = setup();
  session.start();
  host.emit('message', { t: 'attached', contentId: 'c1', cols: 80, rows: 24 });
  clear();
  host.emit('message', { t: 'size', contentId: 'c1', cols: 100, rows: 30 });
  assert.equal(written(), utf8('\x1b]2;Mac 100×30 · тук 100×30\x07'));
});

test('нов локален размер сменя заглавието', () => {
  const local = { cols: 100, rows: 30 };
  const { session, host, written, clear } = setup({ local });
  session.start();
  host.emit('message', { t: 'attached', contentId: 'c1', cols: 80, rows: 24 });
  clear();
  local.cols = 90;
  session.localResized();
  assert.equal(written(), utf8('\x1b]2;Mac 80×24 · тук 90×30\x07'));
});

test('заглавие преди attached е без размера на Mac-а', () => assert.equal(sizeTitle(null, { cols: 1, rows: 2 }), '\x1b]2;Mac ? · тук 1×2\x07'));

test('входът отива към таба', () => {
  const { session, host } = setup();
  session.input(Buffer.from('ls\r'));
  assert.deepEqual(host.calls, [['input', b64('ls\r'), 'c1']]);
});

test('Ctrl+] и r праща resize с локалния размер', () => {
  const { session, host } = setup();
  session.input(Buffer.from('\x1dr', 'binary'));
  assert.deepEqual(host.calls, [['resize', { contentId: 'c1', cols: 100, rows: 30 }]]);
});

test('Ctrl+] и q завършва с изход', () => {
  const { session, host, exits } = setup();
  session.input(Buffer.from('\x1dq', 'binary'));
  assert.deepEqual(exits, [{ code: 0, reason: 'quit' }]);
  assert.deepEqual(host.calls, []);
});

test('detached завършва с причината', () => {
  const { session, host, exits } = setup();
  session.start();
  host.emit('message', { t: 'detached', contentId: 'c1', reason: 'ended' });
  assert.deepEqual(exits, [{ code: 0, reason: 'ended' }]);
});

test('stop затваря таба и връща терминала', () => {
  const { session, host, written } = setup();
  session.start();
  session.stop();
  assert.deepEqual(host.calls.slice(-2), [['close'], ['setActive', false]]);
  assert.ok(written().endsWith(RESTORE));
});

test('срещу mock-а: echo стига до таба и обратно', async (t) => {
  const mock = await startMock();
  const relay = new RelayClient();
  t.after(async () => { relay.stop(); await mock.stop(); });
  const host = new HostController(relay);
  relay.configure(mock.settings);
  host.setActive(true);
  await waitFor(() => host.lastList && listTabs(host.lastList).length > 0, 'list с табове');
  const [tab] = listTabs(host.lastList);
  const chunks = [];
  const session = new AttachSession({ host, contentId: tab.contentId, write: (buf) => chunks.push(Buffer.from(buf)), localSize: () => ({ cols: 80, rows: 24 }) });
  session.start();
  const text = () => Buffer.concat(chunks).toString('utf8');
  await waitFor(() => text().startsWith(CLEAR), 'attached');
  session.input(Buffer.from('echo supa-$((40+2))\r'));
  await waitFor(() => text().includes('supa-42'), 'изходът от echo');
  session.stop();
});
