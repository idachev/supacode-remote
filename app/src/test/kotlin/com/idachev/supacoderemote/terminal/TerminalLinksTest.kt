package com.idachev.supacoderemote.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalLinksTest {

  private fun urls(text: String) = TerminalLinks.find(text).map { it.url }

  @Test
  fun `http и https адрес в реда се намира с точните краища`() {
    val text = "виж https://relay.example.com/a?b=1#c и http://10.0.2.2:8787/x"
    assertEquals(
      listOf(
        TerminalLink(4, 37, "https://relay.example.com/a?b=1#c"),
        TerminalLink(40, 62, "http://10.0.2.2:8787/x"),
      ),
      TerminalLinks.find(text),
    )
  }

  @Test
  fun `пунктуацията след адреса не е част от него`() {
    assertEquals(listOf("https://relay.example.com/docs"), urls("Отвори https://relay.example.com/docs."))
    assertEquals(listOf("https://relay.example.com/a"), urls("адрес: https://relay.example.com/a, после"))
    assertEquals(listOf("https://relay.example.com/x"), urls("готово?! https://relay.example.com/x?!"))
  }

  @Test
  fun `скоба и кавички около адреса остават извън него, скоба в самия адрес остава`() {
    assertEquals(listOf("https://relay.example.com/a"), urls("(виж https://relay.example.com/a)"))
    assertEquals(listOf("https://relay.example.com/a"), urls("\"https://relay.example.com/a\""))
    assertEquals(listOf("https://relay.example.com/a"), urls("<https://relay.example.com/a>"))
    assertEquals(listOf("https://relay.example.com/wiki/A_(b)"), urls("https://relay.example.com/wiki/A_(b)"))
    assertEquals(listOf("https://relay.example.com/a"), urls("[https://relay.example.com/a]"))
  }

  @Test
  fun `кирилица непосредствено около адреса и рамка от TUI не влизат в него`() {
    assertEquals(listOf("https://relay.example.com/a"), urls("│ https://relay.example.com/a │"))
    assertEquals(listOf("https://relay.example.com/път"), urls("адрес:https://relay.example.com/път"))
    assertEquals(listOf("https://relay.example.com/a"), urls("https://relay.example.com/a след"))
  }

  @Test
  fun `без host, друга схема и празно не са линкове`() {
    assertEquals(emptyList<String>(), urls("https:// и http:///x"))
    assertEquals(emptyList<String>(), urls("ftp://relay.example.com file:///etc/hosts javascript:alert(1)"))
    assertEquals(emptyList<String>(), urls(""))
  }

  @Test
  fun `схемата е без значение за малки и главни букви`() {
    assertEquals(listOf("HTTPS://Relay.Example.com/A"), urls("HTTPS://Relay.Example.com/A"))
  }

  @Test
  fun `urlAt дава адреса само за знак в него`() {
    val text = "виж https://relay.example.com/a. край"
    assertNull(TerminalLinks.urlAt(text, 3))
    assertEquals("https://relay.example.com/a", TerminalLinks.urlAt(text, 4))
    assertEquals("https://relay.example.com/a", TerminalLinks.urlAt(text, 30))
    // Точката след адреса вече не е от него.
    assertNull(TerminalLinks.urlAt(text, 31))
    assertNull(TerminalLinks.urlAt(text, -1))
    assertNull(TerminalLinks.urlAt(text, 100))
  }

  @Test
  fun `isWebUrl пуска само http и https с host`() {
    assertTrue(TerminalLinks.isWebUrl("https://relay.example.com"))
    assertTrue(TerminalLinks.isWebUrl("http://10.0.2.2:8787/test"))
    assertFalse(TerminalLinks.isWebUrl("javascript:alert(1)"))
    assertFalse(TerminalLinks.isWebUrl("file:///etc/hosts"))
    assertFalse(TerminalLinks.isWebUrl("https://"))
    assertFalse(TerminalLinks.isWebUrl(" https://relay.example.com"))
    // Само userinfo или само порт не е host (F5).
    assertFalse(TerminalLinks.isWebUrl("http://user@/path"))
    assertFalse(TerminalLinks.isWebUrl("http://a@b@/x"))
    assertFalse(TerminalLinks.isWebUrl("http://:8080/x"))
    assertTrue(TerminalLinks.isWebUrl("https://user@relay.example.com:8443/x"))
  }
}
