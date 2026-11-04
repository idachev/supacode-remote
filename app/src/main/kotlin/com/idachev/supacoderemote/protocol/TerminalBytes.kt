package com.idachev.supacoderemote.protocol

import kotlin.io.encoding.Base64

/**
 * Байтовете на терминала пътуват като base64 в поле `b64`.
 *
 * `kotlin.io.encoding.Base64`, а не `java.util.Base64` (API 26, а minSdk е 24) и не
 * `android.util.Base64` (в JVM тестовете е празен stub).
 */
object TerminalBytes {

  /** Текстът като UTF-8 байтове — така кирилицата и emoji стигат до PTY-то цели. */
  fun encodeText(text: String): String = Base64.encode(text.encodeToByteArray())

  fun encode(bytes: ByteArray): String = Base64.encode(bytes)

  fun decode(b64: String): ByteArray = Base64.decode(b64)
}

/** Байтовете на специалните клавиши. Стрелките са в нормален режим (`ESC [ A`), както казва протоколът. */
object TerminalKeys {
  const val ENTER = "\r"
  const val ESC = "\u001b"
  const val TAB = "\t"
  const val CTRL_C = "\u0003"
  const val CTRL_D = "\u0004"
  const val UP = "\u001b[A"
  const val DOWN = "\u001b[B"
  const val RIGHT = "\u001b[C"
  const val LEFT = "\u001b[D"

  // Страница и начало/край — към програмата (Claude Code превърта своята история с тях).
  const val PAGE_UP = "\u001b[5~"
  const val PAGE_DOWN = "\u001b[6~"
  const val HOME = "\u001b[H"
  const val END = "\u001b[F"

  /**
   * Control кодът на един знак: `c` → 0x03, `[` → ESC, `?` → DEL. Връща `null` за знак
   * без control код — тогава лепкавият Ctrl не се харчи.
   */
  fun control(ch: Char): String? {
    val upper = ch.uppercaseChar()
    return when {
      upper in 'A'..'Z' -> (upper.code - 'A'.code + 1).toChar().toString()
      upper in "@[\\]^_" -> (upper.code and 0x1f).toChar().toString()
      ch == ' ' -> "\u0000"
      ch == '?' -> "\u007f"
      else -> null
    }
  }
}
