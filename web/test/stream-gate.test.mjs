// Случаите от Android `TerminalStreamGateTest`. Пътищата са просто обекти: тестът сам решава
// реда на кадрите от двата сокета.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalStreamGate } from '../src/stream-gate.mjs';

function setup() {
  const relay = { name: 'relay' };
  const lan = { name: 'lan' };
  const newRelay = { name: 'newRelay' };
  const gate = new TerminalStreamGate();
  const deliver = (source, message) => gate.accept(source, message).deliver;
  const attachedOnRelay = () => {
    gate.attachSent(relay, 1, 'c1');
    assert.equal(deliver(relay, attached(1)), true);
    assert.equal(deliver(relay, out('relay-screen')), true);
  };
  return { relay, lan, newRelay, gate, deliver, attachedOnRelay };
}

const out = (marker, contentId = 'c1') => ({ t: 'out', contentId, b64: marker });
const attached = (id, contentId = 'c1') => ({ t: 'attached', id, contentId, cols: 80, rows: 24 });
const size = () => ({ t: 'size', contentId: 'c1', cols: 100, rows: 30 });

test('relay изходът тече, докато LAN attach-ът не отговори', () => {
  const { relay, lan, gate, deliver, attachedOnRelay } = setup();
  attachedOnRelay();
  gate.attachSent(lan, 2, 'c1');
  assert.equal(deliver(relay, out('relay-gap')), true);
  assert.equal(deliver(relay, size()), true);
  const handoff = gate.accept(lan, attached(2));
  assert.equal(handoff.deliver, true);
  assert.deepEqual(handoff.detach, [[relay, 'c1']]);
});

test('след LAN attached relay кадрите се изхвърлят, включително detached', () => {
  const { relay, lan, gate, deliver, attachedOnRelay } = setup();
  attachedOnRelay();
  gate.attachSent(lan, 2, 'c1');
  gate.accept(lan, attached(2));
  assert.equal(deliver(relay, out('relay-late')), false);
  assert.equal(deliver(relay, size()), false);
  assert.equal(deliver(relay, { t: 'detached', contentId: 'c1', reason: 'stream ended' }), false);
  assert.equal(deliver(lan, out('lan-live')), true);
  assert.equal(deliver(relay, { t: 'relay', hostOnline: true }), true);
});

test('след падане на LAN кадрите се приемат едва от attached на новия attach', () => {
  const { relay, lan, gate, deliver, attachedOnRelay } = setup();
  attachedOnRelay();
  gate.attachSent(lan, 2, 'c1');
  gate.accept(lan, attached(2));
  gate.closed(lan);
  assert.equal(deliver(lan, out('lan-late')), false);
  gate.attachSent(relay, 3, 'c1');
  assert.equal(deliver(relay, out('relay-old')), false);
  assert.equal(deliver(relay, attached(1)), false);
  assert.equal(deliver(relay, attached(3)), true);
  assert.equal(deliver(relay, out('relay-live')), true);
});

test('LAN пада преди attached — relay потокът продължава', () => {
  const { relay, lan, gate, deliver, attachedOnRelay } = setup();
  attachedOnRelay();
  gate.attachSent(lan, 2, 'c1');
  gate.closed(lan);
  assert.equal(deliver(lan, attached(2)), false);
  assert.equal(deliver(relay, out('relay-still')), true);
});

test('закъснял relay attached след смяна на LAN не връща пътя', () => {
  const { relay, lan, gate, deliver } = setup();
  gate.attachSent(relay, 1, 'c1');
  gate.attachSent(lan, 2, 'c1');
  assert.equal(deliver(relay, attached(1)), false);
  const handoff = gate.accept(lan, attached(2));
  assert.equal(handoff.deliver, true);
  assert.deepEqual(handoff.detach, [[relay, 'c1']]);
  assert.equal(deliver(relay, out('relay-old')), false);
});

test('нов relay сокет — кадрите на стария не минават', () => {
  const { relay, newRelay, gate, deliver, attachedOnRelay } = setup();
  attachedOnRelay();
  gate.closed(relay);
  assert.equal(deliver(relay, out('old-socket')), false);
  gate.attachSent(newRelay, 4, 'c1');
  assert.equal(deliver(newRelay, attached(4)), true);
  assert.equal(deliver(newRelay, out('new')), true);
});

test('detach по LAN спира и останалия attach по relay-а', () => {
  const { relay, lan, gate, deliver } = setup();
  gate.attachSent(relay, 1, 'c1');
  gate.attachSent(lan, 2, 'c1');
  assert.deepEqual(gate.detachSent(lan, 'c1'), [[relay, 'c1']]);
  assert.equal(deliver(lan, out('after-detach')), false);
});

test('закъснял detach на друг терминал не спира потока на новия', () => {
  const { relay, gate, deliver, attachedOnRelay } = setup();
  attachedOnRelay();
  gate.attachSent(relay, 2, 'c2');
  assert.equal(deliver(relay, attached(2, 'c2')), true);
  assert.deepEqual(gate.detachSent(relay, 'c1'), []);
  assert.equal(deliver(relay, out('new-tab-prompt', 'c2')), true);
});

test('detach от стар екран на същия терминал е остарял', () => {
  const { relay, gate, deliver, attachedOnRelay } = setup();
  attachedOnRelay();
  gate.attachSent(relay, 3, 'c1');
  assert.equal(gate.isStaleDetach('c1', 1), true);
  assert.equal(gate.isStaleDetach('c1', 3), false);
  assert.equal(deliver(relay, attached(3)), true);
  assert.equal(deliver(relay, out('new-screen')), true);
  assert.equal(gate.isStaleDetach('c9', null), false);
});

test('detach по другия път спира и текущия път', () => {
  const { relay, lan, gate, deliver, attachedOnRelay } = setup();
  attachedOnRelay();
  gate.attachSent(lan, 2, 'c1');
  assert.deepEqual(gate.detachSent(lan, 'c1'), [[relay, 'c1']]);
  assert.equal(deliver(relay, out('relay-late')), false);
});
