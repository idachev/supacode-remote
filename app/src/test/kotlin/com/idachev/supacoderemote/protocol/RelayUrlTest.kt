package com.idachev.supacoderemote.protocol

import com.idachev.supacoderemote.settings.RelaySettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RelayUrlTest {

  @Test
  fun `https става wss и http става ws`() {
    assertEquals("wss://relay.example.com/client", RelayUrl.clientUrl("https://relay.example.com"))
    assertEquals("ws://10.0.2.2:8787/client", RelayUrl.clientUrl("http://10.0.2.2:8787"))
    assertEquals("ws://10.0.2.2:8787/client", RelayUrl.clientUrl("ws://10.0.2.2:8787/"))
    assertEquals("wss://h/client", RelayUrl.clientUrl("  WSS://h  "))
  }

  @Test
  fun `client в края не се удвоява`() {
    assertEquals("wss://h/client", RelayUrl.clientUrl("https://h/client"))
    assertEquals("wss://h/sub/client", RelayUrl.clientUrl("https://h/sub/"))
  }

  @Test
  fun `празен адрес и непозната схема са грешка`() {
    assertNull(RelayUrl.clientUrl(""))
    assertNull(RelayUrl.clientUrl("relay.example.com"))
    assertNull(RelayUrl.clientUrl("ftp://h"))
    assertNull(RelayUrl.clientUrl("https://"))
  }

  @Test
  fun `ключ за връзка без схема е https`() {
    assertEquals(
      RelaySettings("https://relay.example.com", "abcde-fghij-klmno-pqrst-uvwxy-z2345"),
      ConnectionKey.parse("  relay.example.com/abcde-fghij-klmno-pqrst-uvwxy-z2345\n"),
    )
  }

  @Test
  fun `ключ за връзка към локален relay пази схемата и порта`() {
    val parsed = ConnectionKey.parse("http://10.0.2.2:8787/test-key")!!
    assertEquals(RelaySettings("http://10.0.2.2:8787", "test-key"), parsed)
    assertEquals("ws://10.0.2.2:8787/client", RelayUrl.clientUrl(parsed.baseUrl))
    assertEquals("http://10.0.2.2:8787", ConnectionKey.relayLabel(parsed.baseUrl))
  }

  @Test
  fun `ключът е след последната наклонена черта`() {
    assertEquals(RelaySettings("https://relay.example.com/sub", "k"), ConnectionKey.parse("relay.example.com/sub/k"))
  }

  @Test
  fun `липсваща част е грешка`() {
    listOf("", "relay.example.com", "relay.example.com/", "/abc", "https:///abc", "https://abc", "ftp://h/k", " / ")
      .forEach { assertNull("трябва да е грешка: '$it'", ConnectionKey.parse(it)) }
  }

  @Test
  fun `записани адрес и ключ стават ключ за връзка и обратно`() {
    val old = RelaySettings("https://relay.example.com/", "abcde-fghij")
    assertEquals("relay.example.com/abcde-fghij", ConnectionKey.format(old))
    assertEquals(RelaySettings("https://relay.example.com", "abcde-fghij"), ConnectionKey.parse(ConnectionKey.format(old)))
    val local = RelaySettings("http://10.0.2.2:8787", "test-key")
    assertEquals("http://10.0.2.2:8787/test-key", ConnectionKey.format(local))
    assertEquals(local, ConnectionKey.parse(ConnectionKey.format(local)))
  }
}
