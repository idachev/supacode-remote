---
name: mock-path-switching
description: Read before testing offline/LAN behaviour with the mock (e2e, emulator) — mock-offline only hits relay clients, LAN comes back ~10 s after mock-lan-on
---

# Mock-ът и смяната на пътя

- **`mock-offline` засяга само клиентите по relay-а** (Mac-ът изчезва от relay-а за 5 s). Клиент
  по LAN не вижда нищо: няма банер, няма „Чакам връзка“. За проба на офлайн първо се пише
  `mock-lan-off` и се чака чипът да стане „Relay“, после `mock-offline`. На телефона банерът по
  LAN нарочно го няма (`ConnectionBanner`).
- **След `mock-lan-on` LAN не се връща веднага.** Новият опит идва след `lanRetryFirstMs` (10 s на
  телефона и в уеб app-а), с растяща пауза. Чип „Relay“ 4 s след `mock-lan-on` е очакван, не е
  грешка.
- e2e тест, който спира LAN, го пуска пак в края (`mock-lan-on` и чака чипа „LAN“). Mock-ът е общ
  за целия файл, а следващите тестове очакват LAN.
