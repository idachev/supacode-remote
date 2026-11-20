---
name: web-app-live-page
description: Read before opening or probing the running web app on port 8790 — a new page takes over the owner's open page
---

# Живият уеб app на 8790

- Уеб app-ът (LaunchAgent `local.supacode-remote.web`) държи **една активна страница**
  (`BrowserLink`). Нова страница или WebSocket към `/ws` поема връзката, а отворената страница
  на собственика получава `replaced`. Затова живият app не се отваря за проба, нито с браузър,
  нито с WebSocket от скрипт.
- За проба се ползват `page.e2e.test.mjs` (Chrome без прозорец срещу mock-а) или собствен сървър
  на друг порт (`PORT=8791 web/run.sh --no-open`). Живият app се проверява само по лога:
  `server.started` носи `sha` и `dirty` (`~/Library/Logs/supacode-remote-web.log`) и `curl` към
  `/`.
- След промени в `web/` app-ът се рестартира с `cd web && ./login-agent.sh install`. Чака се с
  `curl --retry-connrefused`, защото веднага след install порт 8790 още не отговаря.
