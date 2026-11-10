import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientUrl, decode, encode, formatConnectionKey, parseConnectionKey, relayLabel,
} from '../src/protocol.mjs';

test('https става wss и http става ws', () => {
  assert.equal(clientUrl('https://relay.example.com'), 'wss://relay.example.com/client');
  assert.equal(clientUrl('http://10.0.2.2:8787'), 'ws://10.0.2.2:8787/client');
  assert.equal(clientUrl('ws://10.0.2.2:8787/'), 'ws://10.0.2.2:8787/client');
  assert.equal(clientUrl('  WSS://h  '), 'wss://h/client');
});

test('client в края не се удвоява', () => {
  assert.equal(clientUrl('https://h/client'), 'wss://h/client');
  assert.equal(clientUrl('https://h/sub/'), 'wss://h/sub/client');
});

test('празен адрес и непозната схема са грешка', () => {
  for (const bad of ['', 'relay.example.com', 'ftp://h', 'https://', 'https://h:bad', 'https://h:99999', 'https://[']) {
    assert.equal(clientUrl(bad), null, bad);
  }
});

test('избраният Mac отива в host параметъра', () => {
  assert.equal(clientUrl('https://relay.example.com', '3f9a0c1d2e4b5a69'), 'wss://relay.example.com/client?host=3f9a0c1d2e4b5a69');
  assert.equal(clientUrl('https://h', 'a b'), 'wss://h/client?host=a%20b');
  assert.equal(clientUrl('https://h', null), 'wss://h/client');
  assert.equal(clientUrl('https://h', ''), 'wss://h/client');
});

test('ключ за връзка без схема е https', () => {
  assert.deepEqual(parseConnectionKey('  relay.example.com/abcde-fghij-klmno-pqrst-uvwxy-z2345\n'),
    { baseUrl: 'https://relay.example.com', apiKey: 'abcde-fghij-klmno-pqrst-uvwxy-z2345' });
});

test('ключ за връзка към локален relay пази схемата и порта', () => {
  const parsed = parseConnectionKey('http://10.0.2.2:8787/test-key');
  assert.deepEqual(parsed, { baseUrl: 'http://10.0.2.2:8787', apiKey: 'test-key' });
  assert.equal(clientUrl(parsed.baseUrl), 'ws://10.0.2.2:8787/client');
  assert.equal(relayLabel(parsed.baseUrl), 'http://10.0.2.2:8787');
});

test('ключът е след последната наклонена черта', () => {
  assert.deepEqual(parseConnectionKey('relay.example.com/sub/k'), { baseUrl: 'https://relay.example.com/sub', apiKey: 'k' });
});

test('липсваща част е грешка', () => {
  for (const bad of ['', 'relay.example.com', 'relay.example.com/', '/abc', 'https:///abc', 'https://abc', 'ftp://h/k', ' / ',
    'https://example.com:bad/key', 'relay.example.com:70000/key']) {
    assert.equal(parseConnectionKey(bad), null, `трябва да е грешка: '${bad}'`);
  }
});

test('записани адрес и ключ стават ключ за връзка и обратно', () => {
  const old = { baseUrl: 'https://relay.example.com/', apiKey: 'abcde-fghij' };
  assert.equal(formatConnectionKey(old), 'relay.example.com/abcde-fghij');
  assert.deepEqual(parseConnectionKey(formatConnectionKey(old)), { baseUrl: 'https://relay.example.com', apiKey: 'abcde-fghij' });
  const local = { baseUrl: 'http://10.0.2.2:8787', apiKey: 'test-key' };
  assert.equal(formatConnectionKey(local), 'http://10.0.2.2:8787/test-key');
  assert.deepEqual(parseConnectionKey(formatConnectionKey(local)), local);
});

test('ping, pong, счупен JSON и непознат тип не са съобщения', () => {
  for (const text of ['ping', 'pong', '{', '[]', '"x"', '{"t":"nope"}', '{"no":"t"}', 'null']) assert.equal(decode(text), null, text);
});

test('relay без hosts е стар relay, с празен списък е нов', () => {
  const old = decode('{"t":"relay","hostOnline":true}');
  assert.equal(old.hostOnline, true);
  assert.equal(old.hosts, null);
  assert.equal(old.host, null);
  const fresh = decode('{"t":"relay","hostOnline":false,"hosts":[]}');
  assert.deepEqual(fresh.hosts, []);
  const bound = decode('{"t":"relay","hostOnline":true,"host":"h1","hosts":[{"id":"h1","name":"Office Mac","online":true},{"id":"default"}]}');
  assert.equal(bound.host, 'h1');
  assert.deepEqual(bound.hosts, [{ id: 'h1', name: 'Office Mac', online: true }, { id: 'default', name: null, online: false }]);
});

test('hello пази hostId и lan', () => {
  const hello = decode('{"t":"hello","v":1,"host":"Mock Mac","hostId":"h1","lan":{"addrs":["10.0.0.2"],"port":4,"fp":"aa","fpMac":"bb"}}');
  assert.equal(hello.host, 'Mock Mac');
  assert.equal(hello.hostId, 'h1');
  assert.deepEqual(hello.lan, { addrs: ['10.0.0.2'], port: 4, fp: 'aa', fpMac: 'bb' });
  assert.equal(decode('{"t":"hello","v":1}').lan, null);
});

test('hello пази версията на Supacode (`app`); стар host или празно — без версия', () => {
  assert.equal(decode('{"t":"hello","v":1,"app":"Supacode 0.11.5 (154)"}').app, 'Supacode 0.11.5 (154)');
  assert.equal(decode('{"t":"hello","v":1}').app, null);
  assert.equal(decode('{"t":"hello","v":1,"app":""}').app, null);
  assert.equal(decode('{"t":"hello","v":1,"app":7}').app, null);
});

test('терминалните съобщения без задължително поле се изхвърлят', () => {
  assert.equal(decode('{"t":"out","b64":"aGk="}'), null);
  assert.equal(decode('{"t":"attached","contentId":"c","cols":"x","rows":2}'), null);
  assert.deepEqual(decode('{"t":"out","contentId":"c","b64":"aGk="}'), { t: 'out', contentId: 'c', b64: 'aGk=' });
});

test('encode пише JSON', () => {
  assert.equal(encode({ t: 'list', id: 1 }), '{"t":"list","id":1}');
});
