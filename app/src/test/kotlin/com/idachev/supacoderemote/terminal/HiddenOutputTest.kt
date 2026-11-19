package com.idachev.supacoderemote.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HiddenOutputTest {

  @Test
  fun `скритият изход се връща в ред, размерът първи`() {
    val hidden = HiddenOutput()
    assertTrue(hidden.offer("YQ=="))
    hidden.size(100, 30)
    assertTrue(hidden.offer("Yg=="))
    hidden.size(120, 40)
    assertEquals(
      listOf(TerminalCommand.Resize(120, 40), TerminalCommand.Write("YQ=="), TerminalCommand.Write("Yg==")),
      hidden.drain(),
    )
    // След drain буферът е празен.
    assertEquals(emptyList<TerminalCommand>(), hidden.drain())
  }

  @Test
  fun `над 2 MB буферът се изхвърля и казва overflowed`() {
    val hidden = HiddenOutput(capBytes = 4)
    assertTrue(hidden.offer("YWJj")) // 3 байта
    assertFalse(hidden.overflowed)
    assertFalse(hidden.offer("ZGVm")) // още 3 — над тавана
    assertTrue(hidden.overflowed)
    // Препълненият буфер не трупа повече: екранът така или иначе идва наново с attach.
    assertFalse(hidden.offer("eA=="))
    hidden.size(80, 24)
    assertEquals(emptyList<TerminalCommand>(), hidden.drain())
    assertTrue(hidden.overflowed)
    hidden.clear()
    assertFalse(hidden.overflowed)
    assertEquals(OutputPause.CAP_BYTES, HiddenOutput.DEFAULT_CAP_BYTES)
  }
}
