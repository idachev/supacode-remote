# `attach` (етап 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `node web/attach.mjs [таб]` показва един отдалечен таб на Mac-а в текущия локален терминал (Ghostty в локалния Supacode).

**Architecture:** Самостоятелен Node процес. Ползва без промяна `RelayClient` (с LAN пътя), `HostController` и `ConfigStore` от `web/src`. Три нови чисти модула (филтър на въпросите, избор на таб, escape клавиш) и един `AttachSession`, който свързва host-а със stdout/stdin. `web/attach.mjs` е само лепилото: TTY, сигнали, лог във файл.

**Tech Stack:** Node ≥ 22, ESM (`.mjs`), `node:test`, `ws`; mock-ът `tools/mock-host.mjs` през `test/helpers/mock.mjs`.

**Spec:** `docs/plans/done/2026-11-17-ghostty-attach-design.md`

## Global Constraints

- Коментари и KDoc на български, обясняват **защо**. Имената на тестовете на български. Commit съобщенията на български.
- Имената в кода на английски, по `docs/CONTEXT.md` (`RelayClient`, `HostController`, `hostSession`, `contentId`).
- Всичко към потребителя е на български.
- Не се логват ключът, адресът на relay-а и имената на Mac-ове.
- Размерът на таба е на Mac-а: `resize` тръгва само от `Ctrl+]` и после `r` (ЗД12).
- `RelayClient`, `HostController`, `BrowserLink` и страницата не се променят.
- Тестове: `cd web && npm test`. Преди всеки commit: `./build-project.sh` от корена (правило на проекта), с лог в `./tmp/claude-logs/`.

## Review Focus

- Въпрос, разделен между две парчета `out` (`\x1b[` в едното, `c` в другото): трябва да се махне. Тест в Task 1.
- Многобайтова UTF-8 буква на границата на две парчета: трябва да излезе цяла. Тест в Task 1.
- Незатворен OSC/DCS (програмата праща `\x1b]` и никога `BEL`): филтърът не бива да глътне всичко след него. Таван 4096 байта, после се пуска както е. Тест в Task 1.
- Kitty клавиатура включена от програмата: `Ctrl+]` идва като `\x1b[93;5u`. Трябва да работи. Тест в Task 3.
- Нов `attached` при смяна на пътя: екранът и историята се чистят преди redraw-а. Тест в Task 4.

---

### Task 1: `QueryFilter` — маха въпросите към терминала от изхода

**Files:**
- Create: `web/src/query-filter.mjs`
- Test: `web/test/query-filter.test.mjs`

**Interfaces:**
- Produces: `export class QueryFilter { push(bytes: Buffer): Buffer }` — връща байтовете за stdout; незавършена escape последователност се пази до следващия `push`. `export const MAX_PENDING = 4096`.

- [ ] **Step 1: Write the failing tests**

```js
const run = (...chunks) => { const f = new QueryFilter(); return Buffer.concat(chunks.map((c) => f.push(Buffer.from(c, 'binary')))).toString('binary'); };

test('обикновен текст и цветове минават', () => assert.equal(run('a\x1b[31mb\x1b[0m'), 'a\x1b[31mb\x1b[0m'));
test('махат се DA1, DA2, DA3', () => assert.equal(run('x\x1b[c\x1b[0c\x1b[>c\x1b[=cy'), 'xy'));
test('махат се DSR и DECDSR', () => assert.equal(run('\x1b[5n\x1b[6n\x1b[?6n'), ''));
test('махат се DECRQM и частният DECRQM', () => assert.equal(run('\x1b[4$p\x1b[?2004$p'), ''));
test('маха се XTVERSION', () => assert.equal(run('\x1b[>0q'), ''));
test('махат се всички CSI t', () => assert.equal(run('\x1b[14t\x1b[8;40;120t'), ''));
test('маха се kitty въпросът, push и pop минават', () => assert.equal(run('\x1b[?u\x1b[>1u\x1b[<u'), '\x1b[>1u\x1b[<u'));
test('махат се DECRQSS и XTGETTCAP', () => assert.equal(run('\x1bP$qm\x1b\\\x1bP+q544e\x1b\\'), ''));
test('махат се OSC 4/10/11/12 с ?, заглавието минава', () =>
  assert.equal(run('\x1b]11;?\x07\x1b]10;?\x1b\\\x1b]4;1;?\x07\x1b]2;заглавие\x07'), '\x1b]2;заглавие\x07'));
test('OSC 11 със стойност минава', () => assert.equal(run('\x1b]11;rgb:00/00/00\x07'), '\x1b]11;rgb:00/00/00\x07'));
test('режимите на мишката и alternate screen минават', () => assert.equal(run('\x1b[?1049h\x1b[?1006h'), '\x1b[?1049h\x1b[?1006h'));
test('въпрос, разделен на две парчета, се маха', () => assert.equal(run('a\x1b[', '6nb'), 'ab'));
test('кирилица, разделена на две парчета, излиза цяла', () => {
  const f = new QueryFilter(); const bytes = Buffer.from('ж', 'utf8');
  assert.equal(Buffer.concat([f.push(bytes.subarray(0, 1)), f.push(bytes.subarray(1))]).toString('utf8'), 'ж');
});
test('незатворен OSC се пуска след MAX_PENDING байта', () => {
  const f = new QueryFilter(); const big = '\x1b]2;' + 'a'.repeat(MAX_PENDING);
  assert.equal(f.push(Buffer.from(big, 'binary')).toString('binary'), big);
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd web && node --test test/query-filter.test.mjs` → `Cannot find module '../src/query-filter.mjs'`.

- [ ] **Step 3: Implement `QueryFilter`**

Машина на състояния по байтове: `ground`, `esc`, `csi`, `osc`, `osc-esc`, `dcs`, `dcs-esc`. Байтовете извън escape минават веднага (UTF-8 не се пипа: многобайтовите букви нямат `0x1b`, затова разделянето им не е проблем). Последователност се трупа в буфер до края: CSI до финален байт `0x40–0x7E`; OSC до `BEL` или `ESC \`; DCS до `ESC \`. При края се решава:
- CSI: префикс (`?`, `>`, `=`, `<` — първият байт, ако е от тях), междинни байтове `0x20–0x2F`, финал. Маха се: `c` с префикс няма/`>`/`=`; `n` с префикс няма/`?`; `p` с междинен `$`; `q` с префикс `>`; `t` винаги; `u` с префикс `?`.
- OSC: номерът преди първото `;` е 4, 10, 11 или 12 и данните съдържат `?`.
- DCS: първите байтове след `ESC P` са `$q` или `+q`.
- 8-битовите C1 (`0x9b` и др.) не се разпознават: в UTF-8 те са част от букви.
- Ако буферът надмине `MAX_PENDING`, се пуска както е и състоянието е `ground`.

- [ ] **Step 4: Run, expect PASS** — същата команда, всички зелени.

- [ ] **Step 5: Commit** — `git add web/src/query-filter.mjs web/test/query-filter.test.mjs && git commit -m "attach: QueryFilter маха въпросите към терминала от изхода"`

---

### Task 2: Избор на таб от `list`

**Files:**
- Create: `web/src/attach-tabs.mjs`
- Test: `web/test/attach-tabs.test.mjs`

**Interfaces:**
- Produces:
  - `listTabs(list) → Array<{ contentId: string, label: string }>` — в реда на `list.repos[].worktrees[].tabs[]`; `label` е `"<repo.name> / <worktree.name> / <tab.title>"`, липсващо заглавие → `"таб"`. Табове без низ `contentId` се прескачат.
  - `findTab(tabs, query) → { tab } | { error: string }` — точно съвпадение на `contentId`; иначе подниз в `label` без значение на малки/главни букви. Нула съвпадения → `error: 'Няма таб „<query>“'`; повече от едно → `error: '„<query>“ съвпада с <n> таба'`.

- [ ] **Step 1: Write the failing tests**

```js
const list = { repos: [{ name: 'app', worktrees: [{ name: 'main', tabs: [{ contentId: 'c1', title: 'claude' }, { contentId: 'c2' }] },
  { name: 'feat', tabs: [{ contentId: 'c3', title: 'vim' }] }] }] };

test('табовете са в реда на list с етикет repo / worktree / заглавие', () => assert.deepEqual(listTabs(list), [
  { contentId: 'c1', label: 'app / main / claude' }, { contentId: 'c2', label: 'app / main / таб' }, { contentId: 'c3', label: 'app / feat / vim' }]));
test('счупен list дава празен списък', () => assert.deepEqual(listTabs({ repos: [{ worktrees: [{ tabs: [{}] }] }] }), []));
test('намира по contentId', () => assert.equal(findTab(listTabs(list), 'c3').tab.contentId, 'c3'));
test('намира по част от етикета, без значение на главни букви', () => assert.equal(findTab(listTabs(list), 'CLAUDE').tab.contentId, 'c1'));
test('нула съвпадения е грешка', () => assert.equal(findTab(listTabs(list), 'nope').error, 'Няма таб „nope“'));
test('няколко съвпадения е грешка', () => assert.equal(findTab(listTabs(list), 'app').error, '„app“ съвпада с 3 таба'));
```

- [ ] **Step 2: Run, expect FAIL** — `cd web && node --test test/attach-tabs.test.mjs`.
- [ ] **Step 3: Implement `listTabs` и `findTab`** в `web/src/attach-tabs.mjs`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "attach: избор на таб от list"`

---

### Task 3: Escape клавиш `Ctrl+]`

**Files:**
- Create: `web/src/escape-keys.mjs`
- Test: `web/test/escape-keys.test.mjs`

**Interfaces:**
- Produces: `export class EscapeKeys { feed(bytes: Buffer): { forward: Buffer, actions: Array<'resize'|'quit'> } }`. `Ctrl+]` е `0x1d` или `\x1b[93;5u` (kitty). След него следващият клавиш: `r` → `'resize'`, `q` → `'quit'`, втори `Ctrl+]` (която и да е форма) → `forward` получава `0x1d`; друг клавиш се изхвърля. Kitty форми на `r`/`q` (`\x1b[114u`, `\x1b[113u`) също важат. Режимът „чака втори клавиш“ се пази между `feed`.

- [ ] **Step 1: Write the failing tests**

```js
const k = () => new EscapeKeys();
const feed = (e, s) => { const r = e.feed(Buffer.from(s, 'binary')); return { forward: r.forward.toString('binary'), actions: r.actions }; };

test('обикновените байтове минават', () => assert.deepEqual(feed(k(), 'ls\r'), { forward: 'ls\r', actions: [] }));
test('Ctrl+] и r иска resize', () => assert.deepEqual(feed(k(), 'a\x1dr'), { forward: 'a', actions: ['resize'] }));
test('Ctrl+] и q иска изход', () => assert.deepEqual(feed(k(), '\x1dq'), { forward: '', actions: ['quit'] }));
test('двоен Ctrl+] праща един 0x1d', () => assert.deepEqual(feed(k(), '\x1d\x1d'), { forward: '\x1d', actions: [] }));
test('друг клавиш след Ctrl+] се изхвърля', () => assert.deepEqual(feed(k(), '\x1dxb'), { forward: 'b', actions: [] }));
test('Ctrl+] и r в две парчета', () => { const e = k(); feed(e, '\x1d'); assert.deepEqual(feed(e, 'r'), { forward: '', actions: ['resize'] }); });
test('kitty форма на Ctrl+] и r', () => assert.deepEqual(feed(k(), '\x1b[93;5u\x1b[114u'), { forward: '', actions: ['resize'] }));
test('стрелка в kitty режим минава', () => assert.deepEqual(feed(k(), '\x1b[A'), { forward: '\x1b[A', actions: [] }));
```

- [ ] **Step 2: Run, expect FAIL** — `cd web && node --test test/escape-keys.test.mjs`.
- [ ] **Step 3: Implement `EscapeKeys`.** Само точните форми от Interfaces се познават; всичко друго минава непроменено. Разпознаване по низ в буфера е достатъчно (stdin дава цели последователности на клавиш).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "attach: escape клавиш Ctrl+] (resize, изход)"`

---

### Task 4: `AttachSession` — host → stdout, stdin → host

**Files:**
- Create: `web/src/attach-session.mjs`
- Test: `web/test/attach-session.test.mjs`

**Interfaces:**
- Consumes: `QueryFilter` (Task 1), `EscapeKeys` (Task 3), `HostController` (`open`, `close`, `input(b64, contentId)`, `resize({contentId, cols, rows})`, `setActive`, събитие `'message'`).
- Produces:
  ```js
  export class AttachSession extends EventEmitter {
    constructor({ host, contentId, write: (buf) => void, localSize: () => ({cols, rows}), log })
    start()                 // host.setActive(true); host.open(contentId)
    input(bytes: Buffer)    // през EscapeKeys; forward → host.input; 'resize' → host.resize с localSize(); 'quit' → emit('exit', {code: 0, reason: 'quit'})
    localResized()          // ново заглавие
    stop()                  // host.close(); host.setActive(false); write(RESTORE)
  }
  export const CLEAR = '\x1b[3J\x1b[2J\x1b[H'
  export const RESTORE = '\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[0m'
  export function sizeTitle(mac, local) // '\x1b]2;Mac 120×40 · тук 100×30\x07'; без mac → 'Mac ? · тук …'
  ```
  Събития: `'exit'` с `{ code, reason }` — `quit` (код 0) и `detached` (код 0, `reason` от съобщението).
- Поведение при съобщение от host-а (само за `contentId`): `attached` → `write(CLEAR)`, ново `QueryFilter`, `write(sizeTitle(...))`; `out` → `write(filter.push(base64))`; `size` → заглавие; `detached` → `emit('exit', …)`; `error` с този `contentId` → лог `warn`.

- [ ] **Step 1: Write the failing tests** — unit с фалшив host (`EventEmitter` + записани извиквания) и един тест срещу mock-а.

```js
test('attached чисти екрана и пише заглавие с двата размера', () => {
  const { session, host, written } = setup({ local: { cols: 100, rows: 30 } });
  session.start();
  host.emit('message', { t: 'attached', contentId: 'c1', cols: 120, rows: 40 });
  assert.equal(written(), CLEAR + '\x1b]2;Mac 120×40 · тук 100×30\x07');
});
test('out минава през филтъра', () => { /* out с 'a\x1b[6nb' → written съдържа 'ab' */ });
test('кадри за друг таб се прескачат', () => { /* out с contentId 'c2' → нищо */ });
test('Ctrl+] и r праща resize с локалния размер', () => { /* input('\x1dr') → host.resize({contentId:'c1', cols:100, rows:30}) */ });
test('detached завършва с причината', () => { /* emit detached reason 'ended' → exit {code:0, reason:'ended'} */ });
test('stop връща терминала', () => { /* stop() → host.close извикан, written завършва с RESTORE */ });
test('срещу mock-а: echo стига до таба и обратно', async () => {
  // startMock(); RelayClient.configure({baseUrl, apiKey:'test-key'}); HostController;
  // първият list → listTabs → първият таб; AttachSession.start(); waitFor attached;
  // session.input(Buffer.from('echo supa-attach-ok\r')); waitFor written съдържа 'supa-attach-ok' два пъти (ехо + изход).
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd web && node --test test/attach-session.test.mjs`.
- [ ] **Step 3: Implement `AttachSession`** по Interfaces.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "attach: AttachSession свързва host-а с терминала"`

---

### Task 5: `web/attach.mjs` — CLI, ръчна проба, документи

**Files:**
- Create: `web/attach.mjs`
- Modify: `docs/STATUS.md`, `docs/plans/TODO.md` (ако там има точка за това), `CLAUDE.md` (раздел „Уеб app“, един ред за `attach`)

**Interfaces:**
- Consumes: всички по-горе, `ConfigStore`, `parseConnectionKey`, `RelayClient`, `HostController`, `createLogger`.

- [ ] **Step 1: Implement `web/attach.mjs`**
  - Логър: `createLogger({ write })` с `fs.createWriteStream(join(defaultConfigDir(), 'attach.log'), { flags: 'a', mode: 0o600 })`; полето `pid` във всяко `info('attach.*')`.
  - Без ключ → stderr `Няма ключ за връзка. Настрой уеб app-а (web/run.sh) и пробвай пак.`, код 1.
  - `relay.configure(settings, selectedHostId)`; `HostController(relay)`, `host.setActive(true)` за `list`.
  - Чака първия `list` (таван 20 s → stderr `Mac-ът не отговори.`, код 1). С аргумент: `findTab`; грешка → stderr, код 1. Без аргумент: номериран списък в stderr, номер от stdin (`readline`), преди raw режима.
  - После: `process.stdin.setRawMode(true)`, `stdin.on('data', session.input)`, `stdout` за `write`, `localSize` от `process.stdout.columns/rows`, `SIGWINCH` → `localResized()`.
  - `exit`, `SIGHUP`, `SIGTERM`, `SIGINT` (не идва в raw режим, но за всеки случай) → `session.stop()`, `relay.stop()`, raw режим off, `process.exit(code)`. При `detached` преди изхода stderr: `Табът приключи (<reason>).`
- [ ] **Step 2: Пълни тестове** — `cd web && npm test`, всички зелени (лог в `./tmp/claude-logs/`).
- [ ] **Step 3: Ръчна проба срещу mock-а** — `cd tools && node mock-host.mjs`; config с ключ `http://127.0.0.1:8787/test-key` в отделна папка (`SUPACODE_REMOTE_WEB_CONFIG_DIR`); `node web/attach.mjs` в таб на локалния Supacode: списък, избор, shell, `vim`, `less`, скрол с мишката, paste, кирилица, `Ctrl+]` и после `r` (в лога на mock-а — `resize`), `Ctrl+]` и после `q` (терминалът е нормален след изход). Ако `zmx` в локалния Supacode пречи — същото в Terminal.app и запис в STATUS.
- [ ] **Step 4: Проба срещу истинския Mac** (собственикът): Claude Code в отдалечен таб.
- [ ] **Step 5: Документи** — STATUS: какво работи и какво не от пробата; CLAUDE.md: `node web/attach.mjs [таб]`, `Ctrl+]` и после `r`/`q`, лог `attach.log`.
- [ ] **Step 6: Build и commit** — `./build-project.sh` (лог в `./tmp/claude-logs/`), после `git commit -m "attach: CLI за отдалечен таб в истинския терминал (етап 1)"`.
