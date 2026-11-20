---
name: parallel-worktree-builds
description: Read before running builds or tests in several git worktrees at once (parallel agents) — shared Gradle daemon, missing node_modules
---

# Билдове в няколко worktree-та наведнъж

- **Gradle daemon-ът е общ** за всички worktree-та на repo-то (същата версия и JVM).
  `./gradlew --stop` в един worktree спира и билдовете, които текат в другите. Те падат с
  прекъснат daemon. На 2026-11-20 така падна билд на паралелен агент. Ако няколко агента строят
  наведнъж, `--stop` го пуска само последният, или главната сесия накрая. Паднал така билд се
  пуска наново, не се дебъгва.
- **Нов worktree няма `node_modules`.** Преди уеб тестовете се пуска `npm install` в `tools/` и в
  `web/` на самия worktree.
- Паралелните агенти работят върху отделни файлове. Иначе cherry-pick в общ branch дава
  конфликти. Сигнатури, които ползва друг агент, не се сменят.
