package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.protocol.ClientMessage
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.WatchRequest
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ListWatchTest {

  private class FakeLink : HostLink {
    override val messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    override val hostSession = MutableStateFlow<Int?>(1)
    override val hostCaps = MutableStateFlow<Set<String>?>(setOf("watch", "attach.keep"))
    val sent = mutableListOf<ClientMessage>()
    private var id = 0

    override fun send(message: ClientMessage): Boolean {
      sent += message
      return true
    }

    override fun nextId(): Int = ++id
  }

  private val link = FakeLink()
  private val foreground = MutableStateFlow(true)
  private var refreshes = 0

  private fun TestScope.listWatch(): ListWatch =
    ListWatch(link, foreground, refresh = { refreshes++ }, scope = backgroundScope).also { runCurrent() }

  private fun watches(): List<Boolean> = link.sent.filterIsInstance<WatchRequest>().map { it.on }

  @Test
  fun `с watch в caps праща watch и един list`() = runTest {
    val watch = listWatch()
    assertEquals(listOf(WatchRequest(1, true)), link.sent)
    assertEquals(1, refreshes)
    assertTrue(watch.watching.value)
    // Нов caps със същото (напр. повторен hello) не праща втори watch.
    link.hostCaps.value = setOf("watch")
    runCurrent()
    assertEquals(listOf(true), watches())
    assertEquals(1, refreshes)
  }

  @Test
  fun `без watch в caps не праща нищо и watching е false`() = runTest {
    link.hostCaps.value = setOf("attach.keep")
    val watch = listWatch()
    assertTrue(link.sent.isEmpty())
    assertEquals(0, refreshes)
    assertFalse(watch.watching.value)
    // Стар Mac без caps — същото.
    link.hostCaps.value = null
    runCurrent()
    assertTrue(link.sent.isEmpty())
    assertFalse(watch.watching.value)
  }

  @Test
  fun `във фон праща watch off`() = runTest {
    val watch = listWatch()
    foreground.value = false
    runCurrent()
    assertEquals(listOf(true, false), watches())
    assertFalse(watch.watching.value)
    // Обратно пред очите: watch наново и един list.
    foreground.value = true
    runCurrent()
    assertEquals(listOf(true, false, true), watches())
    assertEquals(2, refreshes)
    assertTrue(watch.watching.value)
  }

  @Test
  fun `нова сесия праща watch наново`() = runTest {
    val watch = listWatch()
    link.hostSession.value = null
    runCurrent()
    // Без сесия Mac-ът е забравил watch-а: нищо не тръгва, а watching пада.
    assertEquals(listOf(true), watches())
    assertFalse(watch.watching.value)
    link.hostSession.value = 2
    runCurrent()
    assertEquals(listOf(true, true), watches())
    assertEquals(2, refreshes)
    assertTrue(watch.watching.value)
    // Смяна на пътя е нова сесия без null между тях — пак watch.
    link.hostSession.value = 3
    runCurrent()
    assertEquals(listOf(true, true, true), watches())
  }

  /**
   * RelayClient сменя caps преди сесията: при смяна на пътя за миг се вижда старата сесия с
   * още неизвестни caps на новия сокет. Watch-ът на стария сокет го спира RelayClient; тук
   * `on:false` би отишъл по новия сокет, където watch няма.
   */
  @Test
  fun `неизвестни caps не пращат watch off`() = runTest {
    val watch = listWatch()
    link.hostCaps.value = null
    runCurrent()
    assertEquals(listOf(true), watches())
    assertFalse(watch.watching.value)
    link.hostSession.value = 2
    link.hostCaps.value = setOf("watch")
    runCurrent()
    assertEquals(listOf(true, true), watches())
    assertTrue(watch.watching.value)
  }

  @Test
  fun `caps идват след hostSession — watch тръгва тогава`() = runTest {
    link.hostCaps.value = null
    val watch = listWatch()
    assertTrue(link.sent.isEmpty())
    assertFalse(watch.watching.value)
    link.hostCaps.value = setOf("watch")
    runCurrent()
    assertEquals(listOf(true), watches())
    assertEquals(1, refreshes)
    assertTrue(watch.watching.value)
  }
}
