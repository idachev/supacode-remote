package com.idachev.supacoderemote.terminal

/** Адрес в текста на терминала: [start] и [end] (без него) са индекси в низа. */
data class TerminalLink(val start: Int, val end: Int, val url: String)

/**
 * http/https адресите в изхода на програмата, за отваряне в браузъра с тап.
 *
 * Изходът идва от програмата на Mac-а и не е доверен, затова се отваря само http и https с host:
 * `javascript:` или `file:` от терминала не бива да стигат до браузъра. Същите правила има и уеб
 * app-ът (`web/public/terminal-links.js`).
 */
object TerminalLinks {

  // Адресът свършва на интервал, кавички, ъглови скоби и рамките на TUI-тата. \p{Z} — и Unicode
  // интервалите, както \s в JS. Не (?U): ICU regex-ът на Android не го приема (JVM тестът минава).
  private val URL = Regex("""https?://[^\s\p{Z}"'<>`─-▟]+""", RegexOption.IGNORE_CASE)

  // Частта до `@` (userinfo) и портът не са host: `http://user@/path` и `http://:8080/` не минават.
  private val WEB_URL = Regex("""^https?://(?:[^\s/?#]*@)?[^\s/?#@:][^\s/?#@]*(?=[/?#]|$)""", RegexOption.IGNORE_CASE)

  /** Пунктуацията след адреса в изречение е част от изречението, не от адреса. */
  private const val TRAILING_PUNCTUATION = ".,;:!?"

  private val PAIRS = mapOf(')' to '(', ']' to '[', '}' to '{')

  /** http или https с непразен host. */
  fun isWebUrl(url: String): Boolean = WEB_URL.containsMatchIn(url)

  fun find(text: String): List<TerminalLink> = URL.findAll(text).mapNotNull { m ->
    val url = trimEnd(m.value)
    if (isWebUrl(url)) TerminalLink(m.range.first, m.range.first + url.length, url) else null
  }.toList()

  /** Адресът, в който е знакът с индекс [index], или `null`. */
  fun urlAt(text: String, index: Int): String? = find(text).firstOrNull { index >= it.start && index < it.end }?.url

  private fun trimEnd(url: String): String {
    var end = url.length
    while (end > 0) {
      val part = url.substring(0, end)
      if (part.last() in TRAILING_PUNCTUATION || unbalancedClose(part)) end-- else break
    }
    return url.substring(0, end)
  }

  /** Затваряща скоба без отваряща в адреса е от текста около него: „(виж https://…)“. */
  private fun unbalancedClose(url: String): Boolean {
    val close = url.last()
    val open = PAIRS[close] ?: return false
    return url.count { it == close } > url.count { it == open }
  }
}
