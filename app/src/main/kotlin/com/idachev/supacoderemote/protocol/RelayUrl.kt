package com.idachev.supacoderemote.protocol

import com.idachev.supacoderemote.settings.RelaySettings

/** Адресът на WebSocket-а на телефона от базовия адрес на relay-а. */
object RelayUrl {

  private val schemes = mapOf("https" to "wss", "http" to "ws", "wss" to "wss", "ws" to "ws")

  /**
   * `https://…` → `wss://…/client`, `http://…` → `ws://…/client`. Връща `null` за празен
   * адрес или непозната схема, за да покаже „Настройка“ грешката веднага.
   */
  fun clientUrl(base: String): String? {
    val trimmed = base.trim().trimEnd('/')
    val sep = trimmed.indexOf("://")
    if (sep <= 0) return null
    val scheme = schemes[trimmed.substring(0, sep).lowercase()] ?: return null
    val rest = trimmed.substring(sep + 3)
    if (rest.isEmpty() || rest.startsWith("/")) return null
    val withoutClient = rest.removeSuffix("/client")
    return "$scheme://$withoutClient/client"
  }
}

/**
 * Ключът за връзка: един низ `<relay>/<клиентски ключ>`, който Mac-ът пише в
 * `~/.config/supacode/remote-client-key.txt`, напр. `relay.example.com/abcde-fghij-…`.
 * Без схема адресът е `https://`; локален тестов relay може да носи своя
 * (`http://10.0.2.2:8787/test-key`).
 */
object ConnectionKey {

  private const val DEFAULT_SCHEME = "https://"

  /**
   * Ключът е текстът след **последната** `/`, а преди нея е relay-ът. `null`, ако някоя от
   * двете части липсва или схемата е непозната.
   */
  fun parse(text: String): RelaySettings? {
    val trimmed = text.trim()
    val slash = trimmed.lastIndexOf('/')
    if (slash <= 0) return null
    val key = trimmed.substring(slash + 1).trim()
    val relay = trimmed.substring(0, slash).trim().trimEnd('/')
    if (key.isEmpty() || relay.isEmpty() || relay.endsWith(":")) return null
    val base = if (relay.contains("://")) relay else DEFAULT_SCHEME + relay
    if (RelayUrl.clientUrl(base) == null) return null
    return RelaySettings(base, key)
  }

  /** Обратното на [parse] — за записани по-рано адрес и ключ. `https://` се изпуска. */
  fun format(settings: RelaySettings): String = "${relayLabel(settings.baseUrl)}/${settings.apiKey}"

  /** Relay-ят за потвърждение под полето: без `https://`, другите схеми остават. */
  fun relayLabel(base: String): String = base.trim().trimEnd('/').removePrefix(DEFAULT_SCHEME)
}
