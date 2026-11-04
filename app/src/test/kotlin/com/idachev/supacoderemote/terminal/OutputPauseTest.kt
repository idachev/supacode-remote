package com.idachev.supacoderemote.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutputPauseTest {

  @Test
  fun `без пауза изходът не се поема`() {
    val pause = OutputPause()
    assertFalse(pause.offer("aGk="))
    assertEquals(0L, pause.queuedBytes)
    assertEquals(emptyList<String>(), pause.end())
  }

  @Test
  fun `при пауза изходът се пази по ред и се връща наведнъж`() {
    val pause = OutputPause()
    pause.start()
    assertTrue(pause.offer("aGk="))
    assertTrue(pause.offer("eA=="))
    assertTrue(pause.offer("YWJj"))
    assertEquals(2L + 1 + 3, pause.queuedBytes)
    assertEquals(listOf("aGk=", "eA==", "YWJj"), pause.end())
    assertFalse(pause.paused)
    assertEquals(0L, pause.queuedBytes)
    assertFalse(pause.offer("aGk="))
  }

  @Test
  fun `таванът се преминава едва над лимита`() {
    val pause = OutputPause(capBytes = 3)
    pause.start()
    pause.offer("YWJj")
    assertFalse(pause.overCap)
    pause.offer("eA==")
    assertTrue(pause.overCap)
  }

  @Test
  fun `размерът е в KB или MB`() {
    assertEquals("0 KB", OutputPause.formatSize(0))
    assertEquals("1 KB", OutputPause.formatSize(1))
    assertEquals("12 KB", OutputPause.formatSize(12 * 1024))
    assertEquals("2.0 MB", OutputPause.formatSize(OutputPause.CAP_BYTES))
  }
}
