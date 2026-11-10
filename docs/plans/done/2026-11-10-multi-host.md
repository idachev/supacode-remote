# Няколко Mac-а — план за телефона (ЗД5 + ЗД6)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Стъпките са с `- [ ]`.

**Цел:** телефонът вижда всички Mac-ове на relay-а, свързва се с един (избрания) и сменя.

**Архитектура:** един WebSocket, вързан към един Mac с `/client?host=<id>`. Смяна = нова
връзка. Решението „кой Mac“ е чист клас (`HostChoice`), `RelayClient` само го изпълнява.

**Спецификация:** `docs/plans/2026-11-10-remote-multi-host-design.md` в repo-то на Supacode
(АН1–АН7, ЛН1, ОП9, ОП20, ОТ2). Имената на съобщенията, полетата, `?host=` и API-то
`hosts` / `boundHostId` / `selectHost` са оттам и не се сменят.

## Общи правила

- Без съвместимост със стари телефони (ОТ2). Стар relay (без `hosts`) — режим с един Mac.
- Записан избор никога не се сменя сам (ОП20). Автоматичен избор — само без записан.
- Известия само от свързания Mac (ОП9).
- Текстове (АН5): „Mac-ове“, „на линия“ / „извън линия“, „Mac без име“, „избран“,
  „Смени Mac-а“, „Relay-ят още не познава друг Mac.“, „<име> е извън линия“.
- Всичко към потребителя е на български; тестовете с имена на български.

## Решения, които спецификацията оставя на телефона

- **РШ1. Записаният избор е в `RelayClient` от самото начало.** `RelayClient` получава
  `HostSelection` (интерфейс с `selectedHostId: StateFlow<String?>` и
  `setSelectedHostId(String?)`) в конструктора; `SettingsStore` го наследява. По
  подразбиране е в паметта, за да не се чупят старите тестове. Иначе първата връзка би била
  без `host`, автоматичният избор би презаписал записания и ОП20 пада.
- **РШ2. `HostChoice.decide(saved, status)`** → `None` / `Select(id)` / `AskUser`.
  `hosts == null` → `None`. Без записан: точно един онлайн → `Select`, иначе `AskUser`.
  Със записан: липсва в `hosts` → `AskUser`, иначе `None`.
- **РШ3. Два нови сигнала в `RelayClient`** (добавени, спецификацията не ги забранява):
  `multiHost: StateFlow<Boolean>` (последното `relay` е носило `hosts`) и
  `hostPickRequests: StateFlow<Int>` — брояч, расте при **преход** към `AskUser` в една
  връзка. Навигацията пуска „Mac-ове“ веднъж на стойност (пази последната обработена в
  `AppContainer.handledHostPicks`, колкото живее и броячът), затова повтарящият се списък не
  я отваря пак след Back.
- **РШ4. `boundHostId` = id-то в URL-а на текущата връзка** (записаният избор). Не става
  `null` при reconnect или фон. Смяна е само промяна между id-та.
- **РШ5. LAN проверка на `hostId`** само в `multiHost`, с двата id не-`null`. Чуждо `hostId`
  се третира като грешен `fpMac`: без опит и без retry.
- **РШ6. Името в заглавието** е `hosts[boundHostId].name`; `hello.host` е резерва (стар relay).

## Задачи

### Задача 1 — протокол (АН1)
Файлове: `protocol/Protocol.kt`, `protocol/RelayUrl.kt`, тестове `ProtocolCodecTest`,
`RelayUrlTest`.
- [ ] Тестове: `relay` без `hosts` → `hosts == null`, `host == null`; с `hosts: []` → празен
  списък; `HostInfo` без `name` → `null`, без `online` → `false`; `hello` с `hostId`.
- [ ] `RelayStatus(hostOnline, host: String? = null, hosts: List<HostInfo>? = null)`,
  `HostInfo(id, name: String? = null, online: Boolean = false)`, `HelloReply.hostId`.
- [ ] Тестове: `clientUrl(base, "abc")` → `…/client?host=abc`; id с `%`/`&`/кирилица се
  кодира; `null` → без query. Сигнатура: `clientUrl(base: String, hostId: String? = null)`.

### Задача 2 — `HostChoice` (АН2)
Файлове: нов `relay/HostChoice.kt`, тест `HostChoiceTest`.
- [ ] Тестове за всяко правило от РШ2, плюс: записан `default` присъства → `None`; един
  онлайн и един офлайн без записан → `Select`; нула онлайн без записан → `AskUser`.

### Задача 3 — `RelayClient`, `SettingsStore`, `SessionsRepository` (АН2, АН3, ЛН1)
Файлове: `relay/RelayClient.kt`, `settings/SettingsStore.kt`, `sessions/SessionsRepository.kt`,
`AppContainer.kt`, тестове `RelayClientTest`, `RelayLanTest`.
- [ ] `RelayClientTest`: със записан id заявката е `/client?host=<id>`; без записан и един
  онлайн → нова връзка с `?host=` и записан id; без записан и два онлайн →
  `hostPickRequests` расте, без записване; записан, който липсва в `hosts` → изборът остава,
  `hostPickRequests` расте веднъж при два еднакви `relay`; повторно `hostOnline:true` не
  праща втори `hello`; `selectHost` → нов URL, `hostSession` започва наново; стар relay →
  `multiHost == false`, записаният избор остава; `hosts` се обновява от всяко `relay`.
- [ ] `RelayLanTest`: `hello` с чуждо `hostId` (в multi-host) не тръгва към LAN.
- [ ] Код: `hosts`, `boundHostId`, `multiHost`, `hostPickRequests`, `selectHost(id)`
  (записва, затваря LAN и сокета, нова връзка; същият id → нищо). `SettingsStore` пази
  `selected_host_id` в обикновените preferences. `SessionsRepository` чисти `list`/`repos`
  при смяна на `boundHostId`.

### Задача 4 — mock (АН7)
Файл: `tools/mock-host.mjs`.
- [ ] Състоянието е по host: „Office Mac“ (LAN само той), „Home Mac“ (други repo-та и
  contentId-та), офлайн „Mac mini“, `?host=` връзва клиента, без `host` — несвързан.
  Нови редове: `mock-rename` (сменя името на свързания Mac), `mock-other-off` /
  `mock-other-on` (другият Mac), `MOCK_OLD_RELAY=1` (без `hosts`), `MOCK_LEGACY=1` (още
  `default` без име, онлайн).
- [ ] Commit на ЗД5 (задачи 1–4) след `./build-project.sh`.

### Задача 5 — екранът „Mac-ове“ и заглавието (АН4, АН5)
Файлове: `NavigationKeys.kt`, `Navigation.kt`, нов `ui/hosts/HostsScreen.kt`,
`ui/sessions/SessionsScreen.kt`, `ui/Common.kt` (банер).
- [ ] `HostsKey`; ред: име (или „Mac без име“), „на линия“ / „извън линия“, „избран“.
  Избор → `selectHost` + `resetTo(SessionsKey)`. Празен списък — текстът от АН5.
- [ ] Заглавие на „Сесии“: име + точка; докосване („Смени Mac-а“) отваря „Mac-ове“ само в
  `multiHost`. Банер: „<име> е извън линия“, когато свързаният Mac е извън линия.
- [ ] `hostPickRequests` → `HostsKey` веднъж на стойност.

### Задача 6 — известия (АН6)
Файлове: `alerts/AgentAlerts.kt`, `alerts/AwaitingTracker.kt`, `MainActivity.kt`,
`AppContainer.kt`, тест `AwaitingTrackerTest`.
- [ ] Тест: `reset()` връща чакащите и след него същият таб пак е „започнал“.
- [ ] При смяна на `boundHostId`: махат се известията на стария Mac, tracker-ът се нулира.
  Id на известието и request code = `(hostId + contentId).hashCode()`; `EXTRA_HOST_ID`.
  Докоснато известие от друг Mac → `selectHost`, после терминалът.

### Задача 7 — документи, проверка, ревю
- [ ] `docs/CONTEXT.md`: „Mac в списъка (HostInfo)“, „Избран Mac (selectedHostId)“,
  „Свързан Mac (boundHostId)“. `CLAUDE.md`: правилото за `hostOnline` важи и за `relay`
  само със списък; раздел за няколко Mac-а.
- [ ] Emulator срещу mock-а: снимки на „Mac-ове“, смяна, преименуване, офлайн банер.
- [ ] `./build-project.sh`, `scripts/deploy-apk.sh`, self-review, commit.

## Какво може да изненада (Review Focus)

- Записан Mac, който е офлайн при пускане: изборът остава, банер и „Mac-ове“ (тест в зад. 3).
- Back от „Mac-ове“ при повтарящ се списък: не се отваря пак (брояч, зад. 3 и 5).
- Отворен терминал при смяна: стекът се нулира до „Сесии“ (зад. 5).
- Известие от стар Mac след смяна: махнато (зад. 6).
- Стар relay със записан id: работи като един Mac, LAN не се спира (зад. 3, РШ5).
