# `watch` и `attach keep` — план за изпълнение

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Списъкът идва с `watch`, докато приложението / страницата е пред очите, а последните
4 (телефон) / 8 (уеб) таба остават живи с `attach keep` и връщането към тях е без мрежа.

**Architecture:** Протоколът първо (`Protocol.kt`, `protocol.mjs`). После двата слоя на връзката:
`caps` по сокет и `TerminalStreamGate` по терминал (Kotlin и JS поотделно, с еднакви тестове).
Отгоре: в уеб — набор от живи терминали в `HostController` и по един `TerminalView` за терминал в
страницата; на телефона — `TerminalPool` в `AppContainer`, който държи терминала (WebView + поток)
извън екрана, и `ListWatch`, който решава watch или питане.

**Tech Stack:** Kotlin 2.3 / Compose / OkHttp / kotlinx-serialization / JUnit (JVM тестове);
Node ≥ 22, `node --test`, playwright-core (e2e); xterm.js 5.5.0.

**Spec:** [`2026-11-19-watch-and-attach-keep-design.md`](2026-11-19-watch-and-attach-keep-design.md)
(номерата ДЗ*, ЦЛ*, АЦ* по-долу са от там).

## Global Constraints

- Без нови зависимости и без смяна на версии (`CLAUDE.md`, „Скеле и версии“). DI ръчно, през `AppContainer`.
- Таван на живите терминали: **4** на телефона, **8** в уеб; LRU. Таван на скрития изход на телефона: **2 MB** (`OutputPause.CAP_BYTES`).
- `watch` само при `"watch"` в `caps` на текущия сокет; `keep:true` само при `"attach.keep"` там. Без тях — днешното поведение (3 s питане, един attach).
- Във фон на телефона: `watch` с `on:false`, `AgentWatchService` пита на 15 s без промяна, скритите табове — `detach` (ДЗ3, ДЗ4, ДЗ20).
- Вход, `resize`, `suggest`, скрол към програмата — само към видимия таб (АЦ1).
- Нищо към host-а преди `hostOnline:true`.
- Коментари и KDoc на български, обясняват защо; имена на тестовете — български в backticks (Kotlin) / в низа на `test()` (JS). Имена в кода — от `docs/CONTEXT.md` (нови термини се добавят там в Task 10).
- Преди всеки commit: `./build-project.sh` (лог в `./tmp/claude-logs/` с дата и час) и `cd web && npm test` при промени в `web/`. После commit на телефонни промени — `scripts/deploy-apk.sh`.
- Mock за ръчни проби: свой (`PORT=8797 LAN_PORT=8798 node mock-host.mjs`), не този на 8787 — ползва го сесията във fork-а. Стар Mac в mock-а: `MOCK_LEGACY=1` (Mac `default`, без `caps`).

## Review Focus

- RF1. Смяна relay → LAN при 3 живи таба: след `attached` на видимия по LAN по relay-а тръгват `detach` за всички (и скритите) и `watch` `on:false`; нищо не се губи от видимия (Task 3, тест „след LAN attached на видимия скритите на relay-а получават detach“).
- RF2. Връщане LAN → relay без нов `hello`: `watch` и `keep` се ползват по пазените `caps` на relay сокета (Task 2, тест „caps на relay сокета остават след падане на LAN“).
- RF3. Скрит таб изчезва от `list` или идва `detached` за него: махат се от набора, без грешка на екрана на видимия (Task 5 и Task 8, тестове „скрит таб, изчезнал от list, получава detach“).
- RF4. Бързо A → B → A → B: никой `detach` не спира терминал, който е в набора (Task 3, „закъснял detach на скрит не спира видимия“; Task 8, „бърза смяна не праща detach за таб от набора“).
- RF5. Стар Mac (`MOCK_LEGACY`, без `caps`): смяна на таб прави `detach` + `attach` без `keep`, списъкът се пита на 3 s (Task 5, Task 7, Task 8).

---

### Task 1: Протоколът — `caps`, `watch`, `keep`, `attach_limit`

**Files:**
- Modify: `app/src/main/kotlin/com/idachev/supacoderemote/protocol/Protocol.kt`
- Modify: `web/src/protocol.mjs`
- Test: `app/src/test/kotlin/com/idachev/supacoderemote/protocol/ProtocolCodecTest.kt`, `web/test/protocol.test.mjs`

**Interfaces:**
- Produces (Kotlin): `HelloReply.caps: List<String> = emptyList()`; `@SerialName("watch") data class WatchRequest(val id: Int, val on: Boolean) : ClientMessage`; `@SerialName("watch") data class WatchReply(val id: Int? = null, val on: Boolean = false) : ServerMessage`; `AttachRequest(..., val keep: Boolean? = null)` (при `null` полето се изпуска); `ErrorReply.ATTACH_LIMIT = "attach_limit"`; `object Caps { const val WATCH = "watch"; const val ATTACH_KEEP = "attach.keep" }`.
- Produces (JS): `decode` пуска `watch`; `CAPS = { WATCH: 'watch', ATTACH_KEEP: 'attach.keep' }`; `ATTACH_LIMIT = 'attach_limit'`.

- [ ] **Step 1: Сменете съществуващите тестове, които искат `watch` да е непознат** (`ProtocolCodecTest.kt:176`, `protocol.test.mjs:138` — махнете `watch` от списъка с непознати) и добавете:

```kotlin
@Test fun `hello носи caps, без тях е празен списък`() {
  val hello = ProtocolCodec.decode("""{"t":"hello","v":1,"host":"Mac","caps":["attach.keep","watch","layout"]}""") as HelloReply
  assertEquals(listOf("attach.keep", "watch", "layout"), hello.caps)
  assertEquals(emptyList<String>(), (ProtocolCodec.decode("""{"t":"hello","v":1,"host":"Mac"}""") as HelloReply).caps)
}
@Test fun `watch заявка и отговор`() {
  assertEquals("""{"t":"watch","id":5,"on":true}""", ProtocolCodec.encode(WatchRequest(5, true)))
  assertEquals(WatchReply(5, true), ProtocolCodec.decode("""{"t":"watch","id":5,"on":true}"""))
}
@Test fun `attach с keep и без него`() {
  assertEquals("""{"t":"attach","id":2,"contentId":"c","scrollback":500,"keep":true}""", ProtocolCodec.encode(AttachRequest(2, "c", keep = true)))
  assertEquals("""{"t":"attach","id":2,"contentId":"c","scrollback":500}""", ProtocolCodec.encode(AttachRequest(2, "c")))
}
@Test fun `attach_limit е грешка с contentId`() {
  val e = ProtocolCodec.decode("""{"t":"error","id":2,"code":"attach_limit","contentId":"c","message":"too many"}""") as ErrorReply
  assertEquals(ErrorReply.ATTACH_LIMIT, e.code); assertEquals("c", e.contentId)
}
```

JS: същите четири случая в `protocol.test.mjs` (`decode` на `watch` връща `{t:'watch', id:5, on:true}`; `encode({t:'attach', id:2, contentId:'c', scrollback:500, keep:true})` дава точно този JSON).

- [ ] **Step 2:** `./gradlew :app:testDebugUnitTest --tests '*ProtocolCodecTest'` и `cd web && node --test test/protocol.test.mjs` — FAIL.
- [ ] **Step 3:** Добавете полетата и съобщенията (Kotlin: регистрирайте `"watch" -> WatchReply.serializer()` в декодера до `"list"`, ред ~348; JS: `watch` в списъка с познати типове на `decode`).
- [ ] **Step 4:** Същите команди — PASS.
- [ ] **Step 5:** `./build-project.sh`, `cd web && npm test`; commit „Протокол: caps, watch, attach keep, attach_limit (ПР3)“.

---

### Task 2: `caps` по сокет и `watch` `on:false` на стария сокет

**Files:**
- Modify: `app/src/main/kotlin/com/idachev/supacoderemote/relay/RelayClient.kt`
- Modify: `web/src/relay-client.mjs`
- Test: `app/src/test/kotlin/com/idachev/supacoderemote/relay/RelayLanTest.kt`, `web/test/lan-path.test.mjs` (или `relay-client.test.mjs`, по образеца на съществуващите LAN тестове)

**Interfaces:**
- Consumes: `HelloReply.caps`, `WatchRequest` (Task 1).
- Produces (Kotlin): в `HostLink` — `val hostCaps: StateFlow<Set<String>?>` със стойност по подразбиране в интерфейса (`get() = NO_CAPS`, константа `MutableStateFlow<Set<String>?>(null)` в companion-а), за да не се чупят fake-овете в тестовете; `RelayClient` го дава истински: `caps` на сокета на текущия път; `null` — пътят няма път или `hello` по този сокет още не е дошъл. `RelayClient` помни `caps` за relay сокета и за LAN сесията поотделно (`Map<Any, Set<String>>`, ключ — сокетът; чисти се при `closed`/restart).
- Produces (JS): `relay.state.caps` — масив или `null`, със същото значение; влиза в `'state'` събитието.
- Поведение: `send(WatchRequest(on = true))` запомня сокета, по който е тръгнал. При смяна на пътя, ако запомненият сокет е още отворен и вече не е текущ, по него тръгва `WatchRequest(id, on = false)` (ДЗ8a).

- [ ] **Step 1: Тестове** (Kotlin, в `RelayLanTest` с неговия fake relay/LAN):
  - `` `caps идват от hello на текущия път` `` — relay `hello` с `["watch"]` → `hostCaps == setOf("watch")`; после LAN `hello` с `["watch","attach.keep"]` и пътят е LAN → `setOf("watch","attach.keep")`.
  - `` `caps на relay сокета остават след падане на LAN` `` — LAN пада → пътят е Relay, нов `hello` по relay-а няма → `hostCaps == setOf("watch")`.
  - `` `нов LAN сокет без hello — caps са null` `` — между отварянето на LAN и неговия `hello`.
  - `` `watch по relay-а се спира там при преминаване на LAN` `` — `send(WatchRequest(1,true))` по relay-а; LAN става текущ → fake relay сокетът получава `{"t":"watch","id":…,"on":false}`.
  JS: същите четири в `lan-path.test.mjs` / `relay-client.test.mjs` с `relay.state.caps`.
- [ ] **Step 2:** Пуснете ги — FAIL.
- [ ] **Step 3:** Имплементация: `caps` се записва в `onRelayHello`/`onOwnHello` (Kotlin) и `#onRelayHello`/`#lanText` (JS) към сокета-източник; `hostCaps` се преизчислява в `updateRouteLocked` / `#updateRoute` и при всеки `hello`. Спирането на `watch` — в `updateRouteLocked` / `#updateRoute`, преди новата `hostSession`.
- [ ] **Step 4:** PASS; целите набори (`./build-project.sh`, `npm test`) зелени.
- [ ] **Step 5:** Commit „Връзка: caps по сокет, watch спира на стария път (ДЗ8a, ДЗ8b)“.

---

### Task 3: `TerminalStreamGate` по терминал (Kotlin)

**Files:**
- Modify: `app/src/main/kotlin/com/idachev/supacoderemote/relay/TerminalStreamGate.kt`, `RelayClient.kt` (`send` подава `keep`)
- Test: `app/src/test/kotlin/com/idachev/supacoderemote/relay/TerminalStreamGateTest.kt`

**Interfaces:**
- Produces: `fun attachSent(via: Any, id: Int, contentId: String, keep: Boolean = false)`; останалите методи — същите имена и сигнатури (`detachSent`, `isStaleDetach`, `isAttached`, `closed`, `accept`). Вътрешно: `pending: Map<String, Pending>`, `current: Map<String, Any>` (терминал → път), `attachedOn: Map<Any, MutableSet<String>>`, `latestAttachId` както днес.
- Правила:
  - `attachSent(keep=false)` на път P: Mac-ът ще откачи другите терминали на P → те излизат от `attachedOn[P]` и `current` им (ако е P) се чисти.
  - `accept(Attached C от P)` при `pending[C].via === P` (и id съвпада): `current[C] = P`; `detach` за **всички** двойки (път ≠ P, терминал) в `attachedOn` — и скритите (ДЗ8a).
  - Кадър за C минава само ако `current[C] === source`. `Detached` за C маха C от `attachedOn[source]`.
  - `closed(P)`: маха `attachedOn[P]`, чисти `current` на терминалите с P, маха `pending` с via P.
  - `detachSent(via, C)`: както днес, но само за C; връща другите пътища с C.

- [ ] **Step 1: Тестове** — всички днешни остават без промяна (те са с един терминал и `keep=false`) и минават; нови:
  - `` `два терминала с keep на един път текат заедно` `` — attach A (keep), attached A, attach B (keep), attached B; `Output(A)` и `Output(B)` от същия път → deliver и двата.
  - `` `attach без keep на пътя спира другите терминали там` `` — след горното attach C без keep → `Output(A)` не минава.
  - `` `след LAN attached на видимия скритите на relay-а получават detach` `` — A, B с keep по relay; attach A (keep) по LAN; `Attached(A)` от LAN → `decision.detach` съдържа (relay, A) и (relay, B); `Output(B)` от relay → не минава.
  - `` `изходът на видимия по relay тече до LAN attached` `` — като горното, но преди `Attached(A)` от LAN: `Output(A)` от relay → минава.
  - `` `closed на пътя маха всички терминали по него` `` — `isAttached(A)` и `isAttached(B)` → false.
  - `` `закъснял detach на скрит не спира видимия` `` — detachSent(relay, B) → `Output(A)` от relay минава.
- [ ] **Step 2:** `./gradlew :app:testDebugUnitTest --tests '*TerminalStreamGateTest'` — новите FAIL.
- [ ] **Step 3:** Имплементация по правилата горе; `RelayClient.send` подава `message.keep == true` на `attachSent`.
- [ ] **Step 4:** PASS; `RelayLanTest` („при смяна на пътя…“) и `RelayClientTest` — зелени.
- [ ] **Step 5:** `./build-project.sh`; commit „Gate: потокът се решава по терминал (attach keep, ДЗ14–ДЗ16)“.

---

### Task 4: `TerminalStreamGate` по терминал (уеб)

**Files:**
- Modify: `web/src/stream-gate.mjs`, `web/src/relay-client.mjs` (`send` подава `message.keep === true`)
- Test: `web/test/stream-gate.test.mjs`

**Interfaces:**
- Consumes: правилата и имената от Task 3 (`attachSent(via, id, contentId, keep = false)`).
- Produces: същото за JS.

- [ ] **Step 1:** Същите шест нови теста като в Task 3, с имената на JS (`test('два терминала с keep на един път текат заедно', …)` и т.н.); днешните тестове остават.
- [ ] **Step 2:** `cd web && node --test test/stream-gate.test.mjs` — FAIL.
- [ ] **Step 3:** Имплементация.
- [ ] **Step 4:** PASS; `npm test` зелен.
- [ ] **Step 5:** Commit „Уеб gate: потокът се решава по терминал (ДЗ14–ДЗ16)“.

---

### Task 5: Уеб сървърът — `watch` и набор от живи терминали

**Files:**
- Modify: `web/src/host-controller.mjs`, `web/src/http-server.mjs` (само ако новото събитие `released` трябва да мине към страницата)
- Test: `web/test/attach-session.test.mjs` (по образеца там, срещу mock-а) или нов `web/test/kept-terminals.test.mjs`

**Interfaces:**
- Consumes: `relay.state.caps` (Task 2), `keep` в gate (Task 4), `CAPS`, `ATTACH_LIMIT` (Task 1).
- Produces: `HostController` с `maxKept = 8` (опция на конструктора, `keptLimit`); `this.kept: string[]` (LRU, `kept[0]` — видимият, заменя `openContentId`; запазете getter `openContentId` = `kept[0] ?? null`, защото го ползват `input/line/resize/suggest`); `this.needsAttach: Set<string>`; събитие към страницата `{t:'released', contentId}`, когато терминал излиза от набора (LRU, `detached`, изчезнал от `list`, `reset`).
- Поведение:
  - `#onState` / `caps`: при `caps` с `watch` и активна страница — `{t:'watch', id, on:true}` веднъж за `hostSession` + един `list`; таймерът (`#schedulePoll`) спира. Без `watch` — таймерът както днес. `setActive(false)` → `watch` `on:false` (ако е включен), после днешното.
  - `open(C)`: ДЗ7 — C в `kept` и не е в `needsAttach` → само става първи (без мрежа); иначе `attach` с `keep:true` при `attach.keep` (без него — днешният `close()` + `attach`); над 8 → `detach` на последния + `released`.
  - Нова `hostSession`: `attach` само на видимия; останалите → `needsAttach` (ДЗ8).
  - `#onTerminal`: пуска кадрите за **всеки** терминал в `kept` (не само видимия); `attached` маха C от `needsAttach`; `detached` за скрит → маха го + `released`.
  - `#onList`: терминал от `kept`, който го няма в нито един `tabs[].contentId` → `detach` + `released` (ДЗ12).
  - `attach_limit` → свиване до видимия (`detach` + `released` на другите), `attach` наново, `log.warn` (ДЗ10).

- [ ] **Step 1: Тестове** (срещу mock-а, с лога му):
  - `'с watch в caps списъкът идва без питане на 3 s'` — `listIntervalMs: 200`; за 1 s в лога на mock-а има един `list` заявка, а промяна (`mock-await` в таб) стига до `'message'` с `t:'list'`.
  - `'без watch в caps (стар Mac) списъкът се пита по таймера'` — mock с `MOCK_LEGACY=1`, Mac `default`.
  - `'A → B → A не прави нов attach за A'` — в лога на mock-а след A, B, A има точно два `attach` и нито един `detach`.
  - `'деветият таб пуска най-отдавна видяния'` — `keptLimit: 2`; A, B, C → `detach` за A и `{t:'released', contentId:A}`.
  - `'нова hostSession: attach само на видимия, скритият при връщане'` — `mock-offline` / обратно; после `open(скрития)` → `attach`.
  - `'скрит таб, изчезнал от list, получава detach'`.
  - `'вход към скрит таб не тръгва'` — `input(b64, скрития)` → `false`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Имплементация по поведението горе.
- [ ] **Step 4:** PASS; `npm test` зелен (днешните e2e минават, защото страницата още не е сменена — тя игнорира кадри за друг `contentId` и `released`).
- [ ] **Step 5:** Commit „Уеб сървър: watch и до 8 живи терминала (ДЗ5, ДЗ7–ДЗ12, ДЗ22)“.

---

### Task 6: Уеб страницата — по един `TerminalView` за живите терминали

**Files:**
- Modify: `web/public/app.js`, `web/public/terminal.js` (`TerminalView` — метод `show(visible)` и `dispose()`), `web/public/style.css` (скритият контейнер)
- Test: `web/test/page.e2e.test.mjs`

**Interfaces:**
- Consumes: събитието `released` и кадрите за всички `contentId` от набора (Task 5).
- Produces: `TerminalView.show(visible: boolean)`, `TerminalView.dispose()`; в `app.js` — `terminals: Map<contentId, TerminalView>`; `terminal` (днешната глобална) се заменя с „видимия“ (`currentTerminal()`).
- Поведение: `out`/`size`/`attached`/`detached` се пишат в `TerminalView` на своя `contentId` (създава се при `open`); видимият се вика с `fit()` при показване; `released` → `dispose()` и махане от `Map`. Вход и клавиши — само видимият (днешните проверки по `ui.openContentId`). Презареждане — страницата почва с празна `Map` (ДЗ24).

- [ ] **Step 1: e2e тестове:**
  - `'A → B → A връща същия екран без нов attach'` — в таб A `printf 'маркер-A\n'`; отваряне на B, после A; `screenText()` съдържа `маркер-A` веднага (без да чака), а в лога на mock-а няма нов `attach` за A.
  - `'изходът на скрит таб стига до него'` — в A пуснете `sleep 1; echo късно-A`, веднага B; след 2 s обратно на A → `късно-A` е на екрана.
  - `'вход отива само във видимия таб'` — пишете в B; в лога на mock-а входът е само с `content: <B>`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Имплементация.
- [ ] **Step 4:** `cd web && npm test` — PASS (и всички днешни e2e).
- [ ] **Step 5:** Commit „Уеб страница: живи терминали — смяната на таб е без мрежа (ДЗ23, ДЗ24)“.

---

### Task 7: Телефонът — `ListWatch`: `watch` или питане

**Files:**
- Create: `app/src/main/kotlin/com/idachev/supacoderemote/sessions/ListWatch.kt`
- Modify: `app/src/main/kotlin/com/idachev/supacoderemote/AppContainer.kt` (създава го), `ui/Common.kt` (`PollSessionsWhileVisible` пита само при `!listWatch.watching.value`)
- Test: `app/src/test/kotlin/com/idachev/supacoderemote/sessions/ListWatchTest.kt`

**Interfaces:**
- Consumes: `HostLink.hostCaps`, `HostLink.hostSession` (Task 2), `WatchRequest`, `Caps.WATCH` (Task 1); `appInForeground: StateFlow<Boolean>` от `AppContainer`.
- Produces: `class ListWatch(link: HostLink, foreground: StateFlow<Boolean>, refresh: () -> Unit, scope: CoroutineScope)` с `val watching: StateFlow<Boolean>`.
- Поведение: при (`hostSession != null` и `"watch" in hostCaps` и `foreground`) → `WatchRequest(id, on = true)` веднъж за тази `hostSession` + `refresh()` веднъж; `watching = true`. Фонът (`foreground = false`) при включен watch → `WatchRequest(id, on = false)`; `watching = false`. Нова `hostSession` → `watching = false`, после пак по правилото. `list` push-овете отиват в `SessionsRepository` без промяна (те са `ListReply` с `id = null`; проверете, че `SessionsRepository` ги приема — ако филтрира по `id`, поправете там и добавете тест).

- [ ] **Step 1: Тестове** (fake `HostLink` с `MutableStateFlow` за сесия и caps, записва изпратеното):
  - `` `с watch в caps праща watch и един list` ``
  - `` `без watch в caps не праща нищо и watching е false` ``
  - `` `във фон праща watch off` ``
  - `` `нова сесия праща watch наново` ``
  - `` `caps идват след hostSession — watch тръгва тогава` ``
- [ ] **Step 2:** `./gradlew :app:testDebugUnitTest --tests '*ListWatchTest'` — FAIL.
- [ ] **Step 3:** Имплементация; `AgentWatchService` остава непокътнат (ДЗ4).
- [ ] **Step 4:** PASS; `./build-project.sh`.
- [ ] **Step 5:** Проба в emulator-а със собствен mock: на „Сесии“ `mock-await` в таб → значката се сменя за < 1 s; в лога на mock-а няма `list` на 3 s. Снимка. Commit „Телефон: списъкът с watch, докато приложението е пред очите (ДЗ3)“; `scripts/deploy-apk.sh`.

---

### Task 8: Телефонът — `TerminalSession` и `TerminalPool` (без WebView)

Чистата логика на живия терминал, извадена от `TerminalViewModel`, с JVM тестове. Екранът още не я ползва за повече от един таб.

**Files:**
- Create: `app/src/main/kotlin/com/idachev/supacoderemote/terminal/TerminalSession.kt`, `terminal/TerminalPool.kt`, `terminal/HiddenOutput.kt`
- Modify: `terminal/TerminalViewModel.kt` (attach / `onMessage` за `Attached` / `Output` / `SizeChanged` / `Detached` / пауза минават в `TerminalSession`; VM държи само състоянието на екрана, ДЗ18)
- Test: `app/src/test/kotlin/com/idachev/supacoderemote/terminal/TerminalPoolTest.kt`, `HiddenOutputTest.kt`; съществуващият `TerminalViewModelTest` трябва да остане зелен (адаптирайте конструкцията му, не очакванията)

**Interfaces:**
- Consumes: `HostLink` (с `hostCaps`), `AttachRequest(keep)`, `Caps.ATTACH_KEEP`, `ErrorReply.ATTACH_LIMIT`.
- Produces:
  - `class HiddenOutput(capBytes: Long = OutputPause.CAP_BYTES)`: `fun offer(b64: String): Boolean` (false — над тавана, буферът е изхвърлен), `fun size(cols: Int, rows: Int)`, `fun drain(): List<TerminalCommand>` (първо последният `Resize`, после `Write`-овете в ред), `val overflowed: Boolean`.
  - `class TerminalSession(link: HostLink, val key: TerminalKey, scope: CoroutineScope, ...)`: `val commands: Flow<TerminalCommand>` (един читател — WebView-то), `val phase: StateFlow<AttachPhase>`, `var visible: Boolean` (при `false` изходът отива в `HiddenOutput`; при `true` — `drain()` в `commands`, а при `overflowed` → нов `attach`), `fun onWebReady()`, `fun attach()`, `fun needsAttach()`, `fun release()` (`detach` + спира събирача), `val pause: OutputPause`.
  - `class TerminalPool(link: HostLink, scope: CoroutineScope, limit: Int = 4)`: `fun open(key: TerminalKey): TerminalSession` (LRU, видимият е първи, над `limit` → `release()` на последния), `fun shrinkToVisible()`, `fun backgrounded()` (скритите → `detach` + `needsAttach`), `fun clear()` (смяна на Mac / ключ, ДЗ13), `val sessions: List<TerminalSession>`.
  - `AppContainer` създава пула и вика `pool.clear()` при смяна на `relay.boundHostId` и на настройките (нов ключ) — ДЗ13; тест `` `смяна на Mac-а изчиства пула` ``.
  - Нова `hostSession`: видимата сесия прави `attach`, скритите — `needsAttach()` (ДЗ8). `list` без таба → `release()` (ДЗ12). `attach_limit` → `shrinkToVisible()` + `attach` (ДЗ10).
  - `attach` носи `keep = true`, когато `Caps.ATTACH_KEEP in link.hostCaps.value` и сесията не е първият attach по съвсем нов сокет (`hostCaps == null` → без keep, ДЗ8b).

- [ ] **Step 1: Тестове:**
  - `HiddenOutputTest`: `` `скритият изход се връща в ред, размерът първи` ``; `` `над 2 MB буферът се изхвърля и казва overflowed` ``.
  - `TerminalPoolTest`: `` `петият таб пуска най-отдавна видяния` `` (fake link вижда `DetachRequest(A)`); `` `връщане към таб от пула не праща attach` ``; `` `нова сесия прави attach само на видимия` ``; `` `скрит таб при връщане след нова сесия прави attach` ``; `` `фон пуска скритите и ги маркира за attach` ``; `` `скрит таб, изчезнал от list, получава detach` ``; `` `attach_limit свива пула до видимия` ``; `` `без attach.keep в caps пулът е само видимият` ``; `` `бърза смяна не праща detach за таб от набора` `` (A, B, A, B — изпратените `DetachRequest` са нула); `` `изходът на скрит отива в буфера, при показване в commands` ``.
- [ ] **Step 2:** `./gradlew :app:testDebugUnitTest --tests '*TerminalPoolTest' --tests '*HiddenOutputTest'` — FAIL.
- [ ] **Step 3:** Имплементация; `TerminalViewModel` взима `TerminalSession` от `TerminalPool` вместо сам да прави attach; `onCleared` вече **не** праща `detach` (пулът решава).
- [ ] **Step 4:** PASS; целият `testDebugUnitTest` зелен.
- [ ] **Step 5:** `./build-project.sh`; commit „Телефон: TerminalSession и TerminalPool — терминалът живее извън екрана (ДЗ7–ДЗ13, ДЗ18, ДЗ19)“.

---

### Task 9: Телефонът — WebView-то живее в пула; фон и памет

**Files:**
- Modify: `ui/terminal/TerminalWebView.kt` (приема готово `WebView` от сесията вместо да го създава в `remember`; `DisposableEffect` го откача от родителя, не го унищожава), `terminal/TerminalSession.kt` (държи `WebView?`, създава го лениво с `applicationContext`… вижте бележката), `ui/terminal/TerminalScreen.kt`, `MainActivity.kt` / `SupacodeRemoteApp.kt` (`onTrimMemory`, фон > 5 min → `pool.shrinkToVisible()`; преминаване във фон → `pool.backgrounded()`)
- Test: проба в emulator-а (снимки); JVM тестът за таймера на фона — в `TerminalPoolTest` (`` `5 min във фон свиват пула` `` с подаден часовник)

**Interfaces:**
- Consumes: `TerminalSession`, `TerminalPool` (Task 8).
- Produces: `TerminalSession.webView(context: Context): WebView` — един и същ обект за живота на сесията; `TerminalSession.release()` унищожава WebView-то.
- Бележка: WebView, създадено с Activity context, държи Activity-то; при пресъздаване на Activity (завъртане) старото изтича. Създавайте го с `MutableContextWrapper(activity)` и сменяйте базовия context при закачане (`(webView.context as MutableContextWrapper).baseContext = activity`) — така и `openInBrowser` (`startActivity`) работи от текущото Activity.

- [ ] **Step 1:** Тест за таймера на фона (горе) — FAIL; имплементация; PASS.
- [ ] **Step 2:** Имплементация на откачането / закачането и `MutableContextWrapper`.
- [ ] **Step 3:** `./build-project.sh`; `scripts/deploy-apk.sh`; инсталация в emulator-а.
- [ ] **Step 4: Проба в emulator-а** (свой mock на 8797, ключ `http://10.0.2.2:8797/test-key`), снимка за всяко:
  - A: `seq 1 300`, скрол нагоре до ред ~100; B; обратно на A → същият скрол, без „Свързване“.
  - В A `sleep 3; echo късно-A`, веднага B, след 5 s A → `късно-A` е там.
  - Пет таба един след друг → в лога на mock-а `detach` за първия.
  - Приложението във фон и обратно → скритият таб при отваряне прави `attach` (в лога), видимият работи.
  - Завъртане на екрана в таб → терминалът остава, тап по линк отваря браузъра.
  - `mock-lan-on` / `mock-lan-off` докато има скрит таб → видимият продължава, скритият при връщане прави `attach`.
- [ ] **Step 5:** Commit „Телефон: WebView-то на таба живее в пула; фон и памет (ДЗ17, ДЗ20, ДЗ21)“.

---

### Task 10: Документи

**Files:**
- Modify: `CLAUDE.md` (раздели „Протоколът“, „LAN пътят“ — gate по терминал, „Терминалът“, „Уеб app“, „Известия“), `docs/CONTEXT.md` (термините `TerminalSession`, `TerminalPool`, „жив терминал“, „скрит таб“, `ListWatch`), `docs/STATUS.md` (ПР3), `docs/plans/TODO.md` (ако там има ПР3 / `watch`)

- [ ] **Step 1:** Обновете текста; в STATUS — какво работи, решенията (ОП1, НЧ1, ОП3) и commit-ите.
- [ ] **Step 2:** `./build-project.sh` (само за правилото преди commit); commit „Docs: watch и attach keep (ПР3)“.
- [ ] **Step 3:** Ревю с Codex на целия branch (формат от `CLAUDE.md`, `gpt-6.1-terra`, effort high, read-only, без web); всяка находка — проверка срещу кода, поправка само на потвърдените, отделен commit.
