---
name: kotlinx-json-traps
description: Read before changing how Protocol.kt / ProtocolCodec.kt decode JSON — exceptions kotlinx throws and null handling that differ from the web decoder
paths:
  - "app/src/main/kotlin/**/protocol/*.kt"
  - "app/src/test/kotlin/**/protocol/*.kt"
---

# kotlinx-serialization: капани при четенето на протокола

- **Не само `SerializationException`.** Елемент, прочетен сам с
  `json.decodeFromJsonElement(String.serializer(), element)`, когато е обект (`rowIds:[{}]`),
  хвърля `IndexOutOfBoundsException`. Вътре в обект същата грешка идва като
  `JsonDecodingException`. Затова `LossyReader.readable` хваща `RuntimeException`. Ако хванеш
  само `SerializationException`, тестът с `rowIds:[{}]` пада. Така стана при КЛ3 (2026-11-20).
- **`explicitNulls = false` не прави `null` „липсващо“** за поле без `?` със стойност по
  подразбиране (`focused: Boolean = false`). `"focused":null` е грешка, затова елементът се
  пропуска. Уеб декодерът (`web/src/protocol.mjs`) приема `null` като липсващо, както Mac
  клиентът. Разликата е записана в коментара там. Host-ът не праща `null`, а изпуска полето.
- Тест за пропуснат елемент: същият случай трябва да е и в `ProtocolCodecTest`, и в
  `web/test/protocol.test.mjs`. Пътищата в `onSkip` трябва да са в същия ред: `caps` преди
  `lan` в `hello`.
