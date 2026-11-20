import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACH_LIMIT, CAPS, clientUrl, decode, encode, formatConnectionKey, parseConnectionKey, relayLabel,
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

test('error пази незадължителните `code` и `contentId`; стар host ги изпуска', () => {
  const failed = decode('{"t":"error","id":null,"message":"terminal did not start","code":"resize_failed","contentId":"c1"}');
  assert.deepEqual(failed, { t: 'error', id: null, message: 'terminal did not start', code: 'resize_failed', contentId: 'c1' });
  const old = decode('{"t":"error","id":3,"message":"not attached"}');
  assert.deepEqual(old, { t: 'error', id: 3, message: 'not attached', code: null, contentId: null });
  assert.equal(decode('{"t":"error","message":"x","code":5,"contentId":{}}').code, null);
});

test('worktree.new: успех с таб, успех без таб и без worktreeId', () => {
  const withTab = decode('{"t":"worktree.new","id":7,"repositoryId":"r","worktreeId":"/w/x","name":"x","tabId":"t","contentId":"c"}');
  assert.deepEqual(withTab, { t: 'worktree.new', id: 7, repositoryId: 'r', worktreeId: '/w/x', name: 'x', tabId: 't', contentId: 'c' });
  const noTab = decode('{"t":"worktree.new","id":7,"repositoryId":"r","worktreeId":"/w/x","name":"x"}');
  assert.equal(noTab.contentId, null);
  assert.equal(noTab.tabId, null);
  assert.equal(decode('{"t":"worktree.new","id":7,"repositoryId":"r"}'), null);
});

test('worktree.delete: отговорът иска worktreeId', () => {
  assert.deepEqual(decode('{"t":"worktree.delete","id":8,"worktreeId":"/w/x","repositoryId":"r"}'), { t: 'worktree.delete', id: 8, worktreeId: '/w/x', repositoryId: 'r' });
  assert.equal(decode('{"t":"worktree.delete","id":8}'), null);
});

test('терминалните съобщения без задължително поле се изхвърлят', () => {
  assert.equal(decode('{"t":"out","b64":"aGk="}'), null);
  assert.equal(decode('{"t":"attached","contentId":"c","cols":"x","rows":2}'), null);
  assert.deepEqual(decode('{"t":"out","contentId":"c","b64":"aGk="}'), { t: 'out', contentId: 'c', b64: 'aGk=' });
});

test('encode пише JSON', () => {
  assert.equal(encode({ t: 'list', id: 1 }), '{"t":"list","id":1}');
});

// Отдалеченият клиент в Supacode (branch `remote-client-host`) добави `caps`, `layout`, нови
// съобщения и кодове. Уеб app-ът още не ги ползва: те не бива да чупят нищо.
test('новите полета и съобщения на отдалечения клиент не чупят decoder-а', () => {
  const hello = decode('{"t":"hello","v":1,"host":"Mac","hostId":"h1","caps":["attach.keep","watch","layout","resize.hold"]}');
  assert.equal(hello.host, 'Mac');
  assert.equal(hello.hostId, 'h1');
  const layout = { mode: 'tabsPerSplit', activeGroupId: 'main', groups: [{ id: 'main', tree: { pane: 'p1' } }], panes: [{ id: 'p1', tabIds: ['t1'] }] };
  const list = decode(JSON.stringify({ t: 'list', id: null, repos: [{ id: 'r', name: 'n', worktrees: [{ id: 'w', name: 'main', tabs: [{ id: 't1', contentId: 'c1' }], layout }] }] }));
  assert.equal(list.repos[0].worktrees[0].tabs[0].contentId, 'c1');
  const error = decode('{"t":"error","id":2,"code":"attach_limit","contentId":"c9","message":"too many attached terminals"}');
  assert.deepEqual([error.id, error.code, error.contentId], [2, 'attach_limit', 'c9']);
  for (const t of ['tab.close', 'pane.split', 'pane.close']) assert.equal(decode(JSON.stringify({ t, id: 1 })), null);
});

// ПР3: `watch` и `attach keep` се ползват само ако са в `caps` на сокета (ДЗ1).
test('hello носи caps, без тях е празен списък', () => {
  assert.deepEqual(decode('{"t":"hello","v":1,"host":"Mac","caps":["attach.keep","watch","layout"]}').caps, ['attach.keep', 'watch', 'layout']);
  assert.deepEqual(decode('{"t":"hello","v":1,"host":"Mac"}').caps, []);
  // Стойност от друг тип не чупи hello: непознатото се пренебрегва, както изисква протоколът.
  assert.deepEqual(decode('{"t":"hello","v":1,"caps":["watch",7]}').caps, ['watch']);
  assert.deepEqual(decode('{"t":"hello","v":1,"caps":"watch"}').caps, []);
  assert.deepEqual(CAPS, { WATCH: 'watch', ATTACH_KEEP: 'attach.keep' });
});

test('watch заявка и отговор', () => {
  assert.equal(encode({ t: 'watch', id: 5, on: true }), '{"t":"watch","id":5,"on":true}');
  assert.deepEqual(decode('{"t":"watch","id":5,"on":true}'), { t: 'watch', id: 5, on: true });
  assert.deepEqual(decode('{"t":"watch","id":6,"on":false}'), { t: 'watch', id: 6, on: false });
  assert.deepEqual(decode('{"t":"watch"}'), { t: 'watch', id: null, on: false });
});

test('attach с keep и без него', () => {
  assert.equal(encode({ t: 'attach', id: 2, contentId: 'c', scrollback: 500, keep: true }), '{"t":"attach","id":2,"contentId":"c","scrollback":500,"keep":true}');
  assert.equal(encode({ t: 'attach', id: 2, contentId: 'c', scrollback: 500 }), '{"t":"attach","id":2,"contentId":"c","scrollback":500}');
});

test('attach_limit е грешка с contentId', () => {
  const e = decode('{"t":"error","id":2,"code":"attach_limit","contentId":"c","message":"too many"}');
  assert.equal(e.code, ATTACH_LIMIT);
  assert.equal(ATTACH_LIMIT, 'attach_limit');
  assert.equal(e.contentId, 'c');
});

// КЛ3 (R31 на Mac клиента): лош елемент на масив в `list` се пропуска сам, не целият кадър.
// Същите случаи като в `ProtocolCodecTest` на телефона.
const decodeList = (text) => {
  const skipped = [];
  return { reply: decode(text, (path) => skipped.push(path)), skipped };
};

test('list с таб без contentId пропуска само този таб', () => {
  const { reply, skipped } = decodeList(`{"t":"list","id":1,"repos":[{"id":"r","name":"repo","worktrees":[{"id":"w","name":"main","tabs":[
    {"id":"t1","contentId":"c1"},{"id":"t2"},{"id":"t3","contentId":"c3"}]}]}]}`);
  assert.deepEqual(reply.repos[0].worktrees[0].tabs.map((t) => t.contentId), ['c1', 'c3']);
  assert.deepEqual(skipped, ['repos[0].worktrees[0].tabs[1]']);
});

test('лош агент пропуска само агента, табът остава', () => {
  const { reply, skipped } = decodeList(`{"t":"list","repos":[{"id":"r","name":"repo","worktrees":[{"id":"w","name":"main","tabs":[
    {"id":"t1","contentId":"c1","agents":[{"agent":"claude"},{"agent":"codex","activity":"idle"}]}]}]}]}`);
  assert.deepEqual(reply.repos[0].worktrees[0].tabs[0].agents, [{ agent: 'codex', activity: 'idle' }]);
  assert.deepEqual(skipped, ['repos[0].worktrees[0].tabs[0].agents[0]']);
});

test('worktree и repository без задължително поле се пропускат, другите остават', () => {
  const { reply, skipped } = decodeList(`{"t":"list","repos":[
    {"name":"no id"},
    {"id":"r","name":"repo","rowIds":["w",{}],"worktrees":[{"id":"x"},{"id":"w","name":"main"}]}]}`);
  assert.deepEqual(reply.repos.map((r) => r.id), ['r']);
  assert.deepEqual(reply.repos[0].rowIds, ['w']);
  assert.deepEqual(reply.repos[0].worktrees.map((w) => w.id), ['w']);
  assert.deepEqual(skipped, ['repos[0]', 'repos[1].rowIds[1]', 'repos[1].worktrees[0]']);
});

test('поле, което не е масив, прави собственика лош елемент', () => {
  const { reply, skipped } = decodeList(`{"t":"list","repos":[{"id":"r","name":"repo","worktrees":[
    {"id":"bad","name":"bad","tabs":"x"},{"id":"w","name":"main"}]}]}`);
  assert.deepEqual(reply.repos[0].worktrees.map((w) => w.id), ['w']);
  assert.deepEqual(skipped, ['repos[0].worktrees[0]']);
});

test('поле с грешен тип прави елемента лош, както на телефона', () => {
  const { reply, skipped } = decodeList(`{"t":"list","repos":[{"id":"r","name":"repo","worktrees":[
    {"id":"w","name":"main","tabs":[{"id":"t1","contentId":"c1","focused":"yes"},{"id":"t2","contentId":"c2","title":null}]}]}]}`);
  assert.deepEqual(reply.repos[0].worktrees[0].tabs.map((t) => t.id), ['t2']);
  assert.deepEqual(skipped, ['repos[0].worktrees[0].tabs[0]']);
});

test('repos, което не е масив, отхвърля целия кадър', () => {
  assert.equal(decodeList('{"t":"list","repos":{"id":"r"}}').reply, null);
});

test('секции и loadFailures пропускат лошите елементи', () => {
  const { reply, skipped } = decodeList(`{"t":"list","repos":[],"sections":[{"title":"no kind"},{"kind":"active","worktreeIds":["a",{},"b"]}],
    "loadFailures":[{"message":"no id"},{"repositoryId":"r2","message":"boom"}]}`);
  assert.deepEqual(reply.sections, [{ kind: 'active', worktreeIds: ['a', 'b'] }]);
  assert.deepEqual(reply.loadFailures, [{ repositoryId: 'r2', message: 'boom' }]);
  assert.deepEqual(skipped, ['sections[0]', 'sections[1].worktreeIds[1]', 'loadFailures[0]']);
});

test('здрав list не докладва пропуснати и пази непознатите полета', () => {
  const { reply, skipped } = decodeList('{"t":"list","repos":[{"id":"r","name":"repo","worktrees":[{"id":"w","name":"main","layout":{"x":1}}]}]}');
  assert.deepEqual(reply.repos[0].worktrees[0].layout, { x: 1 });
  assert.deepEqual(skipped, []);
});

// КЛ13: `busy` на таба минава до екрана; стар host го изпуска, а грешен тип прави таба лош.
test('busy на таба се чете, с грешен тип табът се пропуска', () => {
  const { reply, skipped } = decodeList(`{"t":"list","repos":[{"id":"r","name":"repo","worktrees":[{"id":"w","name":"main","tabs":[
    {"id":"t1","contentId":"c1","busy":true},{"id":"t2","contentId":"c2"},{"id":"t3","contentId":"c3","busy":"yes"}]}]}]}`);
  const tabs = reply.repos[0].worktrees[0].tabs;
  assert.deepEqual(tabs.map((tab) => [tab.id, tab.busy]), [['t1', true], ['t2', undefined]]);
  assert.deepEqual(skipped, ['repos[0].worktrees[0].tabs[2]']);
});


// ЧК5: и в `hello` / `relay` пропуснатият елемент се докладва с пътя си, както на телефона (КЛ7).
test('hello с лош елемент в caps и lan addrs докладва пътя им', () => {
  const skipped = [];
  const hello = decode(`{"t":"hello","v":1,"caps":["watch",5,"attach.keep"],
    "lan":{"addrs":["10.0.0.2",{}],"port":8788,"fp":"ab","fpMac":"cd"}}`, (path) => skipped.push(path));
  assert.deepEqual(hello.caps, ['watch', 'attach.keep']);
  assert.deepEqual(hello.lan.addrs, ['10.0.0.2']);
  assert.deepEqual(skipped, ['caps[1]', 'lan.addrs[1]']);
});

test('relay с Mac без id докладва пътя му', () => {
  const skipped = [];
  const relay = decode('{"t":"relay","hostOnline":true,"hosts":[{"id":"a"},{"name":"no id"}]}', (path) => skipped.push(path));
  assert.deepEqual(relay.hosts.map((h) => h.id), ['a']);
  assert.deepEqual(skipped, ['hosts[1]']);
});
