package com.idachev.supacoderemote.terminal

import com.idachev.supacoderemote.settings.TextSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalGridMemoryTest {

  @Test
  fun `без мярка няма размер`() {
    assertNull(TerminalGridMemory().gridFor(TextSize.FIT))
  }

  @Test
  fun `последната мярка важи за размера на текста, при който е мерена`() {
    val memory = TerminalGridMemory()
    memory.remember(TextSize.FIT, 120, 60)
    memory.remember(TextSize.FIT, 120, 113)
    assertEquals(GridSize(120, 113), memory.gridFor(TextSize.FIT))
  }

  @Test
  fun `друг размер на текста не ползва старата мярка`() {
    val memory = TerminalGridMemory()
    memory.remember(TextSize.FIT, 120, 113)
    assertNull(memory.gridFor(12))
    memory.remember(12, 48, 40)
    assertEquals(GridSize(48, 40), memory.gridFor(12))
    assertNull(memory.gridFor(TextSize.FIT))
  }

  @Test
  fun `празна мярка не трие добрата`() {
    val memory = TerminalGridMemory()
    memory.remember(TextSize.FIT, 120, 113)
    memory.remember(TextSize.FIT, 0, 113)
    memory.remember(TextSize.FIT, 120, 0)
    assertEquals(GridSize(120, 113), memory.gridFor(TextSize.FIT))
  }
}
