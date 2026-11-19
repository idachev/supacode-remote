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

// ---- по терминал (attach keep, ДЗ14–ДЗ16) ----
//
// С `keep` Mac-ът държи няколко терминала на една връзка. Правилото на gate-а е същото, но за
// всеки терминал поотделно. Случаите и имената са същите като в Kotlin `TerminalStreamGateTest`.

/** A и B закачени с keep по relay-а; A е видимият. */
function twoOnRelay() {
  const s = setup();
  const { relay, gate, deliver } = s;
  gate.attachSent(relay, 1, 'A', true);
  assert.equal(deliver(relay, attached(1, 'A')), true);
  gate.attachSent(relay, 2, 'B', true);
  assert.equal(deliver(relay, attached(2, 'B')), true);
  return s;
}

/** Двойките `[път, терминал]` в реда, в който тръгват `detach`-овете. */
const pairs = (list) => list.map(([via, c]) => `${via.name}:${c}`);

test('два терминала с keep на един път текат заедно', () => {
  const { relay, gate, deliver } = twoOnRelay();
  assert.equal(deliver(relay, out('a', 'A')), true);
  assert.equal(deliver(relay, out('b', 'B')), true);
  assert.equal(gate.isAttached('A'), true);
  assert.equal(gate.isAttached('B'), true);
});

test('attach без keep на пътя спира другите терминали там', () => {
  const { relay, gate, deliver } = twoOnRelay();
  gate.attachSent(relay, 3, 'C');
  assert.equal(deliver(relay, out('a', 'A')), false);
  assert.equal(deliver(relay, out('b', 'B')), false);
  assert.equal(gate.isAttached('A'), false);
  assert.equal(deliver(relay, attached(3, 'C')), true);
  assert.equal(deliver(relay, out('c', 'C')), true);
});

test('след LAN attached на видимия скритите на relay-а получават detach', () => {
  const { relay, lan, gate, deliver } = twoOnRelay();
  gate.attachSent(lan, 3, 'A', true);
  const handoff = gate.accept(lan, attached(3, 'A'));
  assert.equal(handoff.deliver, true);
  assert.deepEqual(pairs(handoff.detach), ['relay:A', 'relay:B']);
  assert.equal(deliver(relay, out('b-late', 'B')), false);
  assert.equal(deliver(relay, out('a-late', 'A')), false);
  assert.equal(deliver(lan, out('a-live', 'A')), true);
  assert.equal(gate.isAttached('B'), false);
});

test('изходът на видимия по relay тече до LAN attached', () => {
  const { relay, lan, gate, deliver } = twoOnRelay();
  gate.attachSent(lan, 3, 'A', true);
  assert.equal(deliver(relay, out('a-gap', 'A')), true);
  assert.equal(deliver(relay, out('b-gap', 'B')), true);
  // Кадър от LAN преди неговия attached (не би трябвало да дойде) не минава.
  assert.equal(deliver(lan, out('a-early', 'A')), false);
});

test('closed на пътя маха всички терминали по него', () => {
  const { relay, gate, deliver } = twoOnRelay();
  gate.closed(relay);
  assert.equal(gate.isAttached('A'), false);
  assert.equal(gate.isAttached('B'), false);
  assert.equal(deliver(relay, out('a', 'A')), false);
  assert.equal(deliver(relay, out('b', 'B')), false);
});

test('закъснял detach на скрит не спира видимия', () => {
  const { relay, gate, deliver } = twoOnRelay();
  assert.deepEqual(gate.detachSent(relay, 'B'), []);
  assert.equal(deliver(relay, out('a', 'A')), true);
  assert.equal(deliver(relay, out('b', 'B')), false);
  assert.equal(gate.isAttached('A'), true);
  assert.equal(gate.isAttached('B'), false);
});

// Скритият B е тръгнал с attach по relay-а, но още без отговор, когато видимият A мине на LAN.
// detach-ът по relay-а отменя и него: закъснелият му `attached` там не бива да стане текущ.
test('detach при смяна на пътя отменя и чакащия attach там', () => {
  const { relay, lan, gate, deliver } = setup();
  gate.attachSent(relay, 1, 'A', true);
  assert.equal(deliver(relay, attached(1, 'A')), true);
  gate.attachSent(relay, 2, 'B', true);
  gate.attachSent(lan, 3, 'A', true);
  assert.deepEqual(pairs(gate.accept(lan, attached(3, 'A')).detach), ['relay:A', 'relay:B']);
  const late = gate.accept(relay, attached(2, 'B'));
  assert.equal(late.deliver, false);
  assert.deepEqual(late.detach, []);
  assert.equal(deliver(lan, out('lan-live', 'A')), true);
  assert.equal(gate.isAttached('A'), true);
});

// Както преди `keep` с един чакащ attach: attach без keep отменя чакащия attach на друг терминал.
test('attach без keep отменя чакащия attach на друг терминал по същия път', () => {
  const { relay, gate, deliver } = setup();
  gate.attachSent(relay, 1, 'A', true);
  gate.attachSent(relay, 2, 'B');
  assert.equal(gate.isAttached('A'), false);
  assert.equal(deliver(relay, attached(1, 'A')), false);
  assert.equal(deliver(relay, attached(2, 'B')), true);
  assert.equal(deliver(relay, out('b', 'B')), true);
});

// ДЗ8a: при нова сесия по LAN скритият B получава detach по relay-а веднага, а видимият A тече
// по relay-а до своя attached по LAN (АЦ2) — тогава detach само за него.
test('detach на скрит по другите пътища не пипа текущия път', () => {
  const { relay, lan, gate, deliver } = twoOnRelay();
  gate.attachSent(lan, 3, 'A', true);
  assert.deepEqual(pairs(gate.takeOtherPaths('B', lan)), ['relay:B']);
  assert.deepEqual(gate.takeOtherPaths('B', lan), []);
  assert.equal(gate.isAttached('B'), false);
  assert.equal(deliver(relay, out('b-late', 'B')), false);
  assert.equal(deliver(relay, out('a-gap', 'A')), true);
  assert.deepEqual(pairs(gate.accept(lan, attached(3, 'A')).detach), ['relay:A']);
  assert.equal(deliver(lan, out('a-live', 'A')), true);
});

// Ревю F1: A и B сменят пътя заедно; attached на B по LAN идва първи. A още чака своя attached
// там, затова по relay-а тече до него (ДЗ14: detach само за терминала, чийто attached е дошъл).
test('attached на друг терминал не откача терминал, който сменя пътя', () => {
  const { relay, lan, gate, deliver } = twoOnRelay();
  gate.attachSent(lan, 3, 'A', true);
  gate.attachSent(lan, 4, 'B', true);
  const b = gate.accept(lan, attached(4, 'B'));
  assert.equal(b.deliver, true);
  assert.deepEqual(pairs(b.detach), ['relay:B']);
  assert.equal(deliver(relay, out('a-gap', 'A')), true);
  assert.equal(deliver(relay, out('b-late', 'B')), false);
  assert.deepEqual(pairs(gate.accept(lan, attached(3, 'A')).detach), ['relay:A']);
  assert.equal(deliver(relay, out('a-late', 'A')), false);
  assert.equal(deliver(lan, out('a-live', 'A')), true);
});
