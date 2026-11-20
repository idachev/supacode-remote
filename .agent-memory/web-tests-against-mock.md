---
name: web-tests-against-mock
description: Read before writing or debugging web tests that talk to the mock — first session is relay then LAN, hanging npm test, order-dependent server tests
paths:
  - "web/test/*.mjs"
---

# Уеб тестовете срещу mock-а

- **Първата `hostSession` е по relay-а, а LAN я сменя след милисекунди.** Заявка, вързана за
  сесията (`worktree.new`, `worktree.delete`), пратена в този прозорец, получава
  `worktree_lost`, а не отговора на Mac-а. Това е правилното поведение на `HostController`. Такъв
  тест трябва да чака `relay.state.path === 'lan'`, не само `hostSession != null`. Под натоварване
  (паралелни Gradle билдове) LAN тръгва по-бавно, затова такъв тест пада рядко. Така беше с ЧК4
  (2026-11-20).
- **Как се хваща прозорецът нарочно:** в теста
  `relay.on('state', (s) => { if (s.hostSession != null && s.path === 'relay') … })` и заявката се
  праща оттам.
- **Неспряна връзка оставя `npm test` да виси.** Тест, който падне преди `relay.stop()`, оставя
  връзката да се свързва наново, и процесът не свършва. Затова `connect(t)` в
  `relay-client.test.mjs` спира връзката с `t.after`. Нов тест прави същото.
- **`server.test.mjs` зависи от реда.** Ключът се записва в първия тест на файла.
  `--test-name-pattern` за един тест дава „не дочаках: сесия“. Пуска се целият файл.
- `node --test file | grep` буферира и при увиснал тест не показва нищо. Пиши в лог и пускай с
  `command timeout`.
