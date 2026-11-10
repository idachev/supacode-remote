# Локален уеб app за Supacode Remote — дизайн

Дата: 2026-11-10. Статус: за изпълнение (собственикът каза „имплементирай“ след първите
въпроси; решенията без негов отговор са отбелязани „наше решение“).

## Защо

Ivan иска да управлява Supacode на друг Mac от лаптоп с пълна клавиатура и trackpad, без
remote desktop. Remote desktop показва целия екран на другия Mac; тук трябват само табовете
на Supacode, като истински терминали. В тях той пише на агентите (Claude Code, Codex), гледа
дали чакат и работи в shell (ВП2: всичко).

## Цели

1. Една команда пуска app-а на лаптопа; той се отваря на `http://localhost:<port>`.
2. Същото като Android app-а: „Настройка“ с ключа за връзка, списъкът „Сесии“
   (секции, групи, repository-та, worktree-та, табове, агенти), нов таб, „Предложи“, чипът
   LAN / Relay, лентата за връзката („Mac-ът е офлайн“, грешен ключ, нов опит).
3. Терминалът взима истинската клавиатура (Ctrl / Alt / Meta, стрелки, F-клавиши, paste),
   скрол с trackpad-а, маркиране и копиране.
4. Вижда се **един таб** наведнъж, както на телефона (ВП3).
5. Същият relay и същият LAN път като телефона, без промени в relay-а и в Supacode.
6. Готово за няколко Mac-а (multi-host), без преработка, щом relay-ят с `hosts` е deploy-нат.

## Не-цели

- Deploy, hosting, достъп от друга машина. Сървърът слуша само на `127.0.0.1`.
- Промяна на размера на **съществуващ** таб на Mac-а (решение ОП27, виж „Размер“).
- Няколко терминала един до друг.
- Известия „агент чака“ (в `docs/plans/TODO.md` като идея).
- Избор на Mac в UI-а (multi-host picker): идва, когато relay-ят е deploy-нат (TODO).
- Промени в `app/` (Android) — Gradle build-ът остава непипнат.

## Анти-цели

- Ключът за връзка в repo-то, в браузъра или в URL.
- Чужд сайт, отворен в същия браузър, може да пише в терминалите.
- Писане в PTY-то, което потребителят не е направил (отговори на xterm.js, предложение,
  тръгнало само).

## Устройство

```
браузър (http://localhost:8790)            локален Node сървър (127.0.0.1)             навън
 index.html + app.js + xterm.js   ── ws ──▶  BrowserLink ─ HostController ─ RelayClient ── wss ──▶ relay /client
   само екрани и клавиатура       /ws         (Origin/Host проверка)          │  LanSession ── wss (TLS 1.3, pin) ──▶ Mac /lan
                                                                              config.json (~/.config/supacode-remote-web/)
```

**Наше решение: Node сървърът е „телефонът“, браузърът е само екран.**
- Браузърът не може да сложи `Authorization` на WebSocket и не може да закове самоподписан
  сертификат. Node може и двете.
- Състоянието на сесията е в Node: `hostOnline`, `hello`, `list`, текущият `contentId`, нов
  `attach` при всяка нова сесия с host-а, `TerminalStreamGate`. Така тестовете срещу mock-а
  покриват цялата логика, а презареждане на страницата е „снимка на състоянието + нов attach“.

Отхвърлени варианти:
- **Само статична страница, която говори с relay-а.** Няма как да прати ключа в header и да
  закове сертификата на LAN пътя.
- **Relay-ят да приема ключа в URL-а или в subprotocol.** Изисква промяна на relay-а
  (забранено), а ключ в URL остава в логове.
- **Electron / нативно app.** Тежко за лично локално app; браузърът стига.
- **Framework в браузъра (React и др.) с build стъпка.** Екраните са малко; чисти ES модули
  без build са по-прости за пускане и поддръжка.

### Node модули (`web/src/`)

Пренасят Android кода с имената от `docs/CONTEXT.md`:

| Модул | От Android | Какво |
|---|---|---|
| `protocol.mjs` | `Protocol.kt`, `RelayUrl.kt` | `ConnectionKey.parse/format/relayLabel`, `clientUrl(base, hostId?)`, `decode` (търпи непознато и счупено), константи |
| `lan-trust.mjs` | `LanTrust.kt` | `fingerprint`, `fpMacValid` (постоянно време), `pinMatches` |
| `lan-session.mjs` | `LanSession.kt` | пряка връзка: TLS 1.3, сертификатът се проверява **преди** да тръгне HTTP заявката с ключа |
| `stream-gate.mjs` | `TerminalStreamGate.kt` | кой път носи потока на терминала |
| `relay-client.mjs` | `RelayClient.kt` | relay сокетът, пауза 1→30 s, ping 30 s, тишина 75 s, 401 → `unauthorized`, LAN опит и връщане, `hostSession`, `path` |
| `host-controller.mjs` | `SessionsRepository`, `TerminalViewModel`, `NewTabViewModel` | `list` на 3 s, докато има страница; отворен терминал и нов `attach` при нова `hostSession`; заявки с `id` |
| `config-store.mjs` | `SettingsStore` | `config.json` с права 0600 в папка 0700 |
| `browser-link.mjs` | — | локалният WebSocket към страницата |
| `http-server.mjs` | — | статичните файлове и проверките на `Host` / `Origin` |

LAN пинът (наше решение за Node): `ws` получава собствен `https.Agent`, чийто
`createConnection` прави `tls.connect` (само TLS 1.3, `rejectUnauthorized:false`) и връща
сокета **едва след** `secureConnect` и съвпадащ SHA-256 на DER-а на сертификата. Затова
заявката за upgrade (с ключа) не тръгва по чужд сертификат. Грешен `fpMac` — никакъв опит.

Multi-host шевове (без UI сега): `clientUrl(base, hostId)` добавя `?host=`; `decode` пази
`relay.host`, `relay.hosts` (липсващо ≠ празно), `hello.hostId`; състоянието носи `hosts` и
`boundHost`; `config.json` има място за `selectedHostId`; `hello` с `hostId`, различен от
избрания, не пуска LAN. Правилото ОП20 (запазеният избор не се сменя сам) влиза с picker-а.

### Локалният протокол (браузър ⇄ Node, `/ws`)

Текстови JSON кадри. Node е единственият, който говори с host-а.

Браузър → Node:
- `{"t":"open","contentId":"…"}` — покажи този таб (Node прави `detach` на стария и `attach`).
- `{"t":"close"}` — няма отворен терминал.
- `{"t":"input","b64":"…"}` — байтове към отворения терминал.
- `{"t":"suggest"}` — „Предложи“ за отворения терминал.
- `{"t":"tab.new","worktreeId":"…","cols":N,"rows":M}` — нов таб с началния размер (ОП27).
- `{"t":"refresh"}` — `list` веднага.
- `{"t":"setup","connectionKey":"…"}` — запази и свържи.
- `{"t":"reconnect"}`, `{"t":"takeover"}`.

Node → браузър:
- `{"t":"state", configured, relayLabel, connection, retryInMs, reason, hostOnline, hostName, path, hostSession, hosts, boundHost, openContentId}` при всяка промяна. Ключът никога не идва.
- `list`, `attached`, `out`, `size`, `detached`, `suggest`, `tab.new`, `error` — както от host-а
  (за терминала само за отворения `contentId`, след `TerminalStreamGate`).
- `{"t":"setup.result","ok":true|false,"message":"…"}`, `{"t":"replaced"}`.

**Наше решение: втора страница взима управлението.** Mac-ът държи по един `attach` на
връзка, а Node има една връзка. Нова страница става активна; старата получава `replaced` и
показва „Отворено в друг прозорец“ с бутон „Ползвай тук“ (`takeover`).

### Сигурност на локалния сървър

- Слуша само на `127.0.0.1` (порт `8790` или `PORT`).
- Всяка HTTP заявка и upgrade: `Host` трябва да е `localhost:<port>` или `127.0.0.1:<port>`
  (срещу DNS rebinding). Upgrade-ът иска и `Origin` от същите два адреса; иначе 403.
- Ключът е само в `~/.config/supacode-remote-web/config.json` (0600). Към браузъра отива само
  `relayLabel` (relay-ят без ключа).

## Екраните (браузър, `web/public/`)

Чист HTML + CSS + ES модули, xterm.js 5.5.0 от npm (`@xterm/xterm`), сервиран от Node. Без CDN.
Целият текст е на български, както в Android app-а.

- **Настройка.** Едно поле „Ключ за връзка“, обяснението от Android („Ключът е в
  `~/.config/supacode/remote-client-key.txt` на Mac-а — копирай го целия.“), „Запази и свържи“.
  Грешка „Липсва relay или ключ“. Показва се без ключ, при 401 и от бутон в горната лента.
- **Горна лента.** Името на Mac-а, чипът „LAN“ / „Relay“, бутон „Настройка“.
- **Лента за връзката** (над всичко): „Свързване с relay-а…“, „Mac-ът е офлайн“,
  „Relay-ът не прие ключа (401). Провери го.“, „… Нов опит след N s“ + „Свържи отново“.
- **„Сесии“ (наше решение: колона вляво, а не отделен екран).** На лаптопа има място;
  списъкът стои до терминала и сменя таба с един клик. Подредбата е `SessionGroups` от Android
  (секции Active / Pinned, групи със сгъване, repository-та по `rowIds`; без `sections` —
  „Основен“ / „Закачени“ / „Активни“), търсене „Търси сесия или repository“ с `FuzzyMatch`.
  Worktree редът се разгъва и показва табовете (заглавие, агенти с активност: „чака вход“ и
  т.н., „само четене“) и „Нов таб“. Колоната се скрива (Ctrl+⌘+B).
- **Терминалът** (вдясно). Заглавие на таба, „Предложи“, „Копирай всичко“, „Поле за ред“.
  „Свързване с таба…“, „Потокът спря: …“.

## Терминалът

### Размер (решение на собственика ОП27, през Капитана)

- Съществуващ таб: размерът е **винаги** на Mac-а (`attached` и `size`). Браузърът не праща
  размер. Шрифтът се избира така, че колоните **и** редовете на Mac-а да влязат в мястото на
  терминала (между 6 и 22 px); при `size` и при промяна на прозореца — наново.
- Нов таб: `tab.new` носи `cols` и `rows` = колко клетки влизат в мястото на терминала при
  „шрифта за нови табове“ (по подразбиране 14 px, настройка в браузъра). Host-ът ги ограничава
  до 20…500 × 5…200. Докато Mac-ът не показва таба, този размер държи; щом го покаже, идва
  `size` и шрифтът се вписва наново. Стар host игнорира полетата → 120 × 40.

### Вход

- Клавиатурата отива в xterm.js и `onData` се праща като `input` (наше решение: Option е Meta,
  `macOptionIsMeta`, както Ghostty; ⌘ комбинациите остават на браузъра и на app-а).
- **xterm.js не отговаря на програмата.** Отговорите на въпроси (DA1/DA2 `CSI c`, DSR/CPR
  `CSI n`, DECRQM `CSI $ p`, XTVERSION `CSI > q`, OSC 4/10/11/12 с `?`, DCS `$ q`) се спират с
  `term.parser.register*Handler`, който връща `true` — тогава xterm.js не пише нищо в `onData`.
  Отговаря само Ghostty на Mac-а; втори отговор би влязъл в PTY-то като текст. Focus отчетите
  (`CSI ? 1004 h`) също се спират. Проверка: `printf '\033[c\033[6n'` в таба не дава нито един
  `input` в лога на mock-а.
- Paste (⌘V) минава през xterm.js (bracketed paste, ако програмата го е включила).
- Mouse report (скрол на Claude Code, клик) отива към PTY-то от xterm.js. В нормалния буфер
  trackpad-ът превърта историята на браузъра (scrollback 5000).
- Маркиране: с мишката; при програма, която следи мишката — с Option (`macOptionClickForcesSelection`).
  ⌘C копира маркираното; без маркирано ⌘C не прави нищо (Ctrl+C е за програмата).

### Поле за ред и „Предложи“

- Полето под терминала (скрито по подразбиране, Ctrl+⌘+L). Enter праща текста, а после `\r`
  след 150 ms (`sendLine`, както в Android: иначе Claude Code го взима за paste).
- „Предложи“ (Ctrl+⌘+S) пита host-а и показва предложенията. Избраното **само пълни полето за
  ред** и го отваря. Никога не се праща само.

### Клавишни комбинации (наше решение)

Всички са Ctrl+⌘, защото Ctrl сам е на програмата, а ⌘ сам и ⌘+⌥ са на браузъра:
Ctrl+⌘+↑/↓ — предишен / следващ таб в worktree-то; Ctrl+⌘+←/→ — предишен / следващ worktree
от списъка; Ctrl+⌘+N — нов таб; Ctrl+⌘+S — „Предложи“; Ctrl+⌘+L — поле за ред;
Ctrl+⌘+B — колоната „Сесии“; Ctrl+⌘+F — търсене. Подсказка с `?` в горната лента.

## Пускане

```
web/run.sh            # npm install при нужда, после node server.mjs и отваря браузъра
PORT=8791 web/run.sh  # друг порт;  --no-open — без браузър
```

Срещу mock-а: `cd tools && npm install && LAN_ADDRS=127.0.0.1 node mock-host.mjs`, ключ
`http://127.0.0.1:8787/test-key`.

## Mock-ът (`tools/mock-host.mjs`, само добавки)

- `tab.new`: нов таб в worktree-то с нов `contentId`, shell с `cols` × `rows` (ограничени
  20…500 × 5…200) или 120 × 40; отговор `tab.new`; непознат worktree → `error` със `id`.
- `knownContent` става динамичен. Android app-ът не се засяга.

## Тестове (`node --test`, в `web/test/`)

- `protocol`: ключът за връзка и `clientUrl` (векторите от `RelayUrlTest`, плюс `?host=`),
  `decode` с непознато, счупено, `relay` с/без `hosts`.
- `lan-trust`: векторът от `LanTrustTest` (изчислен с Node).
- `lan-session`: TLS сървър с **чужд** сертификат — до него не стига нито един байт HTTP;
  TLS 1.2 сървър — отказ; грешен `fpMac` — никакъв опит; верен — upgrade с ключа.
- `stream-gate`: случаите от `TerminalStreamGateTest`.
- `session-groups`, `fuzzy-match`: основните случаи от Android тестовете (модулът е общ за
  браузъра и Node).
- `relay-client` + `host-controller` срещу истинския mock (случайни портове,
  `LAN_ADDRS=127.0.0.1`): 401; `hostOnline` → `hello` → LAN път; `list`; `open` → `attached` +
  `out`; `input` стига до PTY-то; `mock-lan-off` → обратно на Relay и нов `attach`;
  `mock-offline` → `hostOnline:false` и после нов `attach`; `tab.new` с размер.
- `http-server` / `browser-link`: чужд `Origin` и чужд `Host` → 403; ключът не излиза в `state`;
  втора страница → `replaced` за първата.
- Ръчно в истински браузър (Playwright) срещу mock-а: снимка на екраните, проба на клавишите и
  на отговорите на xterm.js в hex лога.

## Оставено на изпълнителя

Точните CSS и цветове (тъмна тема като Android), имената на вътрешните функции, броят файлове
в `web/public/`, дали `session-groups` е един или два модула.
