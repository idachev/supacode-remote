package com.idachev.supacoderemote.protocol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalBytesTest {

  @Test
  fun `кирилица и emoji минават цели през base64`() {
    val text = "Здравей, свят! Тест с ъ, ю, я и 👋🏽 и 🇧🇬\r"
    val b64 = TerminalBytes.encodeText(text)
    val bytes = TerminalBytes.decode(b64)
    assertArrayEquals(text.toByteArray(Charsets.UTF_8), bytes)
    assertEquals(text, bytes.toString(Charsets.UTF_8))
  }

  @Test
  fun `base64 е стандартният с padding`() {
    assertEquals("0JA=", TerminalBytes.encodeText("А")) // кирилско А = D0 90
    assertEquals("DQ==", TerminalBytes.encodeText("\r"))
    assertEquals("8J+Riw==", TerminalBytes.encodeText("👋"))
  }

  @Test
  fun `байтове, които не са UTF-8, също се връщат цели`() {
    val raw = byteArrayOf(0x1b, 0x5b, 0x41, 0xff.toByte(), 0x00, 0x80.toByte())
    assertArrayEquals(raw, TerminalBytes.decode(TerminalBytes.encode(raw)))
  }

  @Test
  fun `control кодовете на лепкавия Ctrl`() {
    assertEquals("\u0003", TerminalKeys.control('c'))
    assertEquals("\u0003", TerminalKeys.control('C'))
    assertEquals("\u0001", TerminalKeys.control('a'))
    assertEquals("\u001a", TerminalKeys.control('z'))
    assertEquals("\u001b", TerminalKeys.control('['))
    assertEquals("\u001f", TerminalKeys.control('_'))
    assertEquals("\u0000", TerminalKeys.control(' '))
    assertEquals("\u007f", TerminalKeys.control('?'))
    assertNull(TerminalKeys.control('1'))
    assertNull(TerminalKeys.control('я'))
  }

  @Test
  fun `бутонът ^L праща същия байт като Ctrl и L`() {
    assertEquals("\u000c", TerminalKeys.CTRL_L)
    assertEquals(TerminalKeys.control('l'), TerminalKeys.CTRL_L)
  }
}
