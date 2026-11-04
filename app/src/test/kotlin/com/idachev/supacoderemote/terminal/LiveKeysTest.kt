package com.idachev.supacoderemote.terminal

import org.junit.Assert.assertEquals
import org.junit.Test

/** Последователностите са каквито Gboard праща през InputConnection. */
class LiveKeysTest {

  private val out = StringBuilder()
  private val keys = LiveKeys { out.append(it) }

  /** Какво би видял shell-ът: DEL трие последния code point. */
  private fun screen(): String {
    val points = mutableListOf<Int>()
    out.toString().codePoints().forEach { if (it == 0x7f) points.removeLastOrNull() else points += it }
    return String(points.toIntArray(), 0, points.size)
  }

  @Test
  fun `думата в процес отива буква по буква и не се удвоява при commit`() {
    listOf("e", "ec", "ech", "echo").forEach(keys::setComposing)
    keys.commit("echo")
    keys.commit(" ")
    listOf("d", "di", "dir", "dire", "direc", "direct").forEach(keys::setComposing)
    keys.finishComposing()
    keys.key(LiveKeys.Key.Enter)
    assertEquals("echo direct\r", out.toString())
  }

  @Test
  fun `commit с интервал след думата праща само интервала`() {
    listOf("l", "ls").forEach(keys::setComposing)
    keys.commit("ls ")
    assertEquals("ls ", out.toString())
  }

  @Test
  fun `автокорекцията сменя думата с DEL и разликата`() {
    listOf("t", "te", "teh").forEach(keys::setComposing)
    keys.commit("the ")
    assertEquals("teh\u007f\u007fhe ", out.toString())
    assertEquals("the ", screen())
  }

  @Test
  fun `кирилица и emoji по code point`() {
    listOf("з", "зд", "здр", "здра", "здрав", "здраве", "здравей").forEach(keys::setComposing)
    keys.commit("здравей ")
    keys.commit("👋")
    keys.key(LiveKeys.Key.Backspace)
    assertEquals("здравей 👋\u007f", out.toString())
    assertEquals("здравей ", screen())
  }

  @Test
  fun `Backspace в думата в процес и в празно поле`() {
    listOf("a", "ab", "abc").forEach(keys::setComposing)
    keys.setComposing("ab")
    keys.finishComposing()
    keys.key(LiveKeys.Key.Backspace)
    keys.deleteBefore(2)
    assertEquals("abc\u007f\u007f\u007f\u007f", out.toString())
    assertEquals("", screen())
  }

  @Test
  fun `триене вътре в думата в процес не я праща пак`() {
    listOf("a", "ab").forEach(keys::setComposing)
    keys.deleteBefore(1)
    keys.setComposing("ac")
    keys.finishComposing()
    assertEquals("ac", screen())
  }

  @Test
  fun `единичен клавиш за y n и Enter като нов ред от клавиатурата`() {
    keys.commit("y")
    keys.commit("\n")
    keys.key(LiveKeys.Key.Text("n"))
    assertEquals("y\rn", out.toString())
  }
}
