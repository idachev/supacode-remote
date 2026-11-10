// Логът: четимият ред (общ за Node и браузъра) и JSON редът на сървъра.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldText, formatMessage } from '../public/log-format.js';
import { createLogger } from '../src/log.mjs';

function capture(level) {
  const lines = [];
  const log = createLogger({ level, write: (line) => lines.push(line) });
  return { log, lines, records: () => lines.map((l) => JSON.parse(l)) };
}

test('фиксирано съобщение, после стойностите по реда на извикването', () => {
  assert.equal(formatMessage('relay.state', { connection: 'connected', path: 'lan', host_online: true }),
    'relay state, connection: connected, path: lan, host_online: true');
  // Същата операция с друг резултат има същото начало.
  const a = formatMessage('lan.closed', { address: '10.0.0.2', reason: 'затворена (1006)' });
  const b = formatMessage('lan.closed', { address: '10.0.0.2', reason: 'timeout' });
  assert.equal(a.split(', reason')[0], b.split(', reason')[0]);
});

test('кавички само за свободен текст; празни и falsey стойности се виждат', () => {
  assert.equal(fieldText('GET'), 'GET');
  assert.equal(fieldText('/api/search'), '/api/search');
  assert.equal(fieldText("Can't read file"), "'Can''t read file'");
  assert.equal(fieldText(''), "''");
  assert.equal(fieldText(0), '0');
  assert.equal(fieldText(false), 'false');
  assert.equal(fieldText(null), 'null');
  assert.equal(fieldText(undefined), 'undefined');
  assert.equal(fieldText(10n), '10n');
  assert.equal(fieldText(new Error('boom here')), "'boom here'");
});

test('управляващите знаци не чупят реда', () => {
  assert.equal(fieldText('a\nb\x1b[2J'), "'a\\x0ab\\x1b[2J'");
});

test('общ обект не е цикъл, истинският цикъл е маркиран', () => {
  const shared = { n: 1 };
  assert.equal(fieldText({ one: shared, two: shared }), `'{"one":{"n":1},"two":{"n":1}}'`);
  const loop = { a: 1 };
  loop.self = loop;
  assert.equal(fieldText(loop), `'{"a":1,"self":"[Circular]"}'`);
});

test('сървърът пише един JSON ред с полетата отделно', () => {
  const { log, lines, records } = capture('info');
  log.info('lan.connected', { address: '10.0.0.2', host_session: 3 });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('\n'));
  const r = records()[0];
  assert.equal(r.severity, 'INFO');
  assert.equal(r.event, 'lan.connected');
  assert.equal(r.message, 'lan connected, address: 10.0.0.2, host_session: 3');
  assert.equal(r.host_session, 3);
  assert.match(r.timestamp, /^\d{4}-\d\d-\d\dT/);
});

test('грешката е тип, текст и стек в края', () => {
  const { log, records } = capture('info');
  log.error('page.failed', { message_type: 'setup', error: new TypeError('bad thing') });
  const r = records()[0];
  assert.equal(r.severity, 'ERROR');
  assert.equal(r.error_type, 'TypeError');
  assert.equal(r.error, 'bad thing');
  assert.ok(r.stack.includes('TypeError'));
  assert.deepEqual(Object.keys(r).slice(-3), ['error_type', 'error', 'stack']);
});

test('изключено ниво не форматира нищо', () => {
  const { log, lines } = capture('warn');
  let touched = false;
  log.info('relay.state', { get connection() { touched = true; return 'x'; } });
  assert.equal(lines.length, 0);
  assert.equal(touched, false);
});

test('грешка при писане или форматиране не стига до извикващия', () => {
  const broken = createLogger({ write: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => broken.info('server.started', { port: 1 }));
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  log.info('relay.state', { get connection() { throw new Error('getter'); } });
  assert.equal(JSON.parse(lines[0]).event, 'log.failed');
  assert.ok(!lines[0].includes('getter'));
});
