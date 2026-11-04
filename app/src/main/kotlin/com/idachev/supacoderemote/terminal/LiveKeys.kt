package com.idachev.supacoderemote.terminal

/**
 * „Живи клавиши“: всеки знак от клавиатурата на телефона отива към PTY-то веднага.
 *
 * Клавиатурата (Gboard) не праща клавиши, а редактира текст: `setComposingText` пише и
 * пренаписва „думата в процес“, `commitText` я приключва, `deleteSurroundingText` трие.
 * Тук това се превежда в байтове към терминала по разликата спрямо вече изпратеното:
 * ако думата „ech“ стане „echo“, отива само „o“; ако автокорекцията смени „teh“ на „the“,
 * отиват два DEL и „he“. Така нищо не се удвоява и нищо не се губи.
 *
 * Сравнението е по code point, не по `Char`: emoji е два `Char`, а за shell-а е един знак,
 * който един DEL трие.
 */
class LiveKeys(private val send: (String) -> Unit) {

  /** Думата в процес, вече изпратена към PTY-то. */
  private var composing: String = ""

  fun setComposing(text: String) {
    replaceComposing(text)
  }

  /** Приключена дума или знак. Полето след това е празно. */
  fun commit(text: String) {
    replaceComposing(text)
    composing = ""
  }

  /** Клавиатурата приема думата в процес такава, каквато е — тя вече е изпратена. */
  fun finishComposing() {
    composing = ""
  }

  /** Backspace, поискан като триене на текст. По един DEL на знак. */
  fun deleteBefore(count: Int) {
    if (count <= 0) return
    // Ако клавиатурата трие от думата в процес, тя вече е на екрана — махаме я и от паметта.
    val points = composing.codePoints().toArray()
    val keep = (points.size - count).coerceAtLeast(0)
    composing = String(points, 0, keep)
    send(DEL.repeat(count))
  }

  /** Отделен клавиш: Backspace, Enter или знак от физическа клавиатура / `adb input`. */
  fun key(key: Key) {
    when (key) {
      Key.Backspace -> {
        // Празно поле: клавиатурата праща клавиш вместо триене на текст.
        composing = ""
        send(DEL)
      }
      Key.Enter -> {
        composing = ""
        send(ENTER)
      }
      is Key.Text -> commit(key.text)
    }
  }

  private fun replaceComposing(text: String) {
    val old = composing.codePoints().toArray()
    val new = text.codePoints().toArray()
    var common = 0
    while (common < old.size && common < new.size && old[common] == new[common]) common++
    val removed = old.size - common
    val added = String(new, common, new.size - common)
    val out = DEL.repeat(removed) + added.toTerminal()
    if (out.isNotEmpty()) send(out)
    composing = text
  }

  /** Enter от клавиатурата идва като `\n`; терминалът чака `\r`. */
  private fun String.toTerminal(): String = replace('\n', '\r')

  sealed interface Key {
    data object Backspace : Key

    data object Enter : Key

    data class Text(val text: String) : Key
  }

  companion object {
    const val DEL = "\u007f"
    const val ENTER = "\r"
  }
}
