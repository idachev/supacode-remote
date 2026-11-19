package com.idachev.supacoderemote.terminal

/**
 * Изходът на скрит таб (ДЗ19). Скритият таб не рисува: откачено WebView може да е спряно от
 * системата и да трупа JS, затова байтовете чакат тук и се пишат наведнъж, когато табът се покаже.
 *
 * Таванът е като на „Пауза“. Над него буферът се изхвърля ([overflowed]): при показване
 * екранът идва наново с нов `attach`, вместо телефонът да пази произволно много изход.
 */
class HiddenOutput(private val capBytes: Long = DEFAULT_CAP_BYTES) {

  private val writes = ArrayList<String>()
  private var bytes = 0L
  private var resize: TerminalCommand.Resize? = null

  /** Буферът е бил препълнен и изхвърлен; изчиства се с [clear] (нов attach). */
  var overflowed: Boolean = false
    private set

  /** `false` — над тавана: буферът е изхвърлен и нищо повече не се пази до [clear]. */
  fun offer(b64: String): Boolean {
    if (overflowed) return false
    writes += b64
    bytes += OutputPause.decodedSize(b64)
    if (bytes <= capBytes) return true
    drop()
    overflowed = true
    return false
  }

  /** `size` за скрит таб: важи само последният. */
  fun size(cols: Int, rows: Int) {
    if (!overflowed) resize = TerminalCommand.Resize(cols, rows)
  }

  /**
   * Чакащото за страницата: първо последният размер, после изходът по ред. Mac-ът вече е на
   * този размер, а изходът е за него. След препълване — нищо: екранът идва с нов attach.
   */
  fun drain(): List<TerminalCommand> {
    val out = listOfNotNull(resize) + writes.map { TerminalCommand.Write(it) }
    drop()
    return out
  }

  /** Нов attach носи целия екран: старото чакащо (и препълването) вече не важат. */
  fun clear() {
    drop()
    overflowed = false
  }

  private fun drop() {
    writes.clear()
    bytes = 0
    resize = null
  }

  companion object {
    /** Колкото „Пауза“ ([OutputPause.CAP_BYTES]). */
    const val DEFAULT_CAP_BYTES: Long = OutputPause.CAP_BYTES
  }
}
