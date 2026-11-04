package com.idachev.supacoderemote.terminal

import java.util.Locale

/**
 * Пауза на изгледа, докато има маркирано: новият изход от Mac-а не се пише в xterm.js, а се
 * пази по ред тук, за да не избута маркирания текст нагоре. PTY-то и Mac-ът продължават;
 * нищо не се губи — при края на паузата всичко се пише наведнъж.
 *
 * Над [capBytes] паузата трябва да спре сама (паметта на телефона и времето за наваксване).
 */
class OutputPause(private val capBytes: Long = CAP_BYTES) {

  /** Защо паузата е свършила; от това зависи дали маркираното се отменя и има ли съобщение. */
  enum class EndReason { Copied, Cancelled, SelectionGone, Overflow, Input, Resize, Reattach }

  private val queue = ArrayList<String>()

  var paused: Boolean = false
    private set

  /** Байтовете в опашката (декодирани, не base64). */
  var queuedBytes: Long = 0
    private set

  fun start() {
    paused = true
  }

  /**
   * Изход по време на пауза. Връща `false`, ако не е поет (няма пауза) — тогава се пише
   * веднага. При пауза го пази и връща `true`; дали е преминат таванът казва [overCap].
   */
  fun offer(b64: String): Boolean {
    if (!paused) return false
    queue += b64
    queuedBytes += decodedSize(b64)
    return true
  }

  val overCap: Boolean get() = queuedBytes > capBytes

  /** Край на паузата: опашката по ред, за запис наведнъж. Без пауза — празен списък. */
  fun end(): List<String> {
    val out = queue.toList()
    queue.clear()
    queuedBytes = 0
    paused = false
    return out
  }

  companion object {
    const val CAP_BYTES: Long = 2L * 1024 * 1024

    /** Точният размер на декодираното, без да се декодира. */
    fun decodedSize(b64: String): Long {
      val pad = when {
        b64.endsWith("==") -> 2
        b64.endsWith("=") -> 1
        else -> 0
      }
      return b64.length / 4L * 3 - pad
    }

    /** „12 KB“ / „1.4 MB“ за чипа „Пауза“. */
    fun formatSize(bytes: Long): String =
      if (bytes < 1024L * 1024) {
        "${(bytes + 1023) / 1024} KB"
      } else {
        String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024))
      }
  }
}
