package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.Attached
import com.idachev.supacoderemote.protocol.Detached
import com.idachev.supacoderemote.protocol.RelayStatus
import com.idachev.supacoderemote.protocol.Output
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.SizeChanged
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Пътищата тук са просто обекти: тестът сам решава реда на кадрите от двата сокета, без нишки
 * и без паузи. Това е редът, в който RelayClient ги подава под deliverLock-а.
 */
class TerminalStreamGateTest {

  private val relay = Any()
  private val lan = Any()
  private val newRelay = Any()
  private val gate = TerminalStreamGate()

  private fun out(marker: String) = Output("c1", marker)

  private fun attached(id: Int) = Attached(id = id, contentId = "c1", cols = 80, rows = 24)

  private fun deliver(source: Any, message: ServerMessage): Boolean = gate.accept(source, message).deliver

  private fun attachedOnRelay() {
    gate.attachSent(relay, 1, "c1")
    assertTrue(deliver(relay, attached(1)))
    assertTrue(deliver(relay, out("relay-screen")))
  }

  /** F3: старият поток тече до `attached` на новия — няма дупка преди redraw-а. */
  @Test
  fun `relay изходът тече, докато LAN attach-ът не отговори`() {
    attachedOnRelay()
    gate.attachSent(lan, 2, "c1")
    assertTrue(deliver(relay, out("relay-gap")))
    assertTrue(deliver(relay, SizeChanged("c1", 100, 30)))
    val handoff = gate.accept(lan, attached(2))
    assertTrue(handoff.deliver)
    // Чак сега relay attach-ът спира.
    assertEquals(listOf(relay to "c1"), handoff.detach)
  }

  /** F1: кадър по relay-а след LAN `attached` (на път преди detach-а) не стига до екрана. */
  @Test
  fun `след LAN attached relay кадрите се изхвърлят, включително detached`() {
    attachedOnRelay()
    gate.attachSent(lan, 2, "c1")
    gate.accept(lan, attached(2))
    assertFalse(deliver(relay, out("relay-late")))
    assertFalse(deliver(relay, SizeChanged("c1", 100, 30)))
    assertFalse(deliver(relay, Detached("c1", "stream ended")))
    assertTrue(deliver(lan, out("lan-live")))
    // Не-терминални съобщения минават по всеки път.
    assertTrue(deliver(relay, RelayStatus(hostOnline = true)))
  }

  /** F2: след падане на LAN старият relay поток не се смесва с новия attach преди redraw-а. */
  @Test
  fun `след падане на LAN кадрите се приемат едва от attached на новия attach`() {
    attachedOnRelay()
    gate.attachSent(lan, 2, "c1")
    gate.accept(lan, attached(2))
    gate.closed(lan)
    assertFalse(deliver(lan, out("lan-late")))
    gate.attachSent(relay, 3, "c1")
    // Закъснели кадри от стария relay attach (id 1) преди отговора на новия.
    assertFalse(deliver(relay, out("relay-old")))
    assertFalse(deliver(relay, attached(1)))
    assertTrue(deliver(relay, attached(3)))
    assertTrue(deliver(relay, out("relay-live")))
  }

  @Test
  fun `LAN пада преди attached — relay потокът продължава`() {
    attachedOnRelay()
    gate.attachSent(lan, 2, "c1")
    gate.closed(lan)
    assertFalse(deliver(lan, attached(2)))
    assertTrue(deliver(relay, out("relay-still")))
  }

  @Test
  fun `закъснял relay attached след смяна на LAN не връща пътя`() {
    gate.attachSent(relay, 1, "c1")
    // LAN се вдига, преди relay-ят да отговори.
    gate.attachSent(lan, 2, "c1")
    assertFalse(deliver(relay, attached(1)))
    val handoff = gate.accept(lan, attached(2))
    assertTrue(handoff.deliver)
    // Mac-ът държи attach и по relay-а — спира се.
    assertEquals(listOf(relay to "c1"), handoff.detach)
    assertFalse(deliver(relay, out("relay-old")))
  }

  @Test
  fun `нов relay сокет — кадрите на стария не минават`() {
    attachedOnRelay()
    gate.closed(relay)
    assertFalse(deliver(relay, out("old-socket")))
    gate.attachSent(newRelay, 4, "c1")
    assertTrue(deliver(newRelay, attached(4)))
    assertTrue(deliver(newRelay, out("new")))
  }

  @Test
  fun `detach по LAN спира и останалия attach по relay-а`() {
    gate.attachSent(relay, 1, "c1")
    gate.attachSent(lan, 2, "c1")
    assertEquals(listOf(relay to "c1"), gate.detachSent(lan, "c1"))
    assertFalse(deliver(lan, out("after-detach")))
  }

  /**
   * Нов таб: екранът му прави attach, преди закъснелият `detach` на предишния терминал
   * (onCleared) да тръгне по същия път. Този detach е за друг терминал и не бива да спира
   * потока на новия — иначе входът минава, а изходът се изхвърля до рестарт на аппа.
   */
  @Test
  fun `закъснял detach на друг терминал не спира потока на новия`() {
    attachedOnRelay()
    gate.attachSent(relay, 2, "c2")
    assertTrue(deliver(relay, Attached(id = 2, contentId = "c2", cols = 80, rows = 24)))
    assertEquals(emptyList<Pair<Any, String>>(), gate.detachSent(relay, "c1"))
    assertTrue(deliver(relay, Output("c2", "new-tab-prompt")))
  }

  /** Бързо A→B→A: закъснелият detach на стария екран A е остарял и не тръгва. */
  @Test
  fun `detach от стар екран на същия терминал е остарял`() {
    attachedOnRelay()
    gate.attachSent(relay, 3, "c1")
    assertTrue(gate.isStaleDetach("c1", 1))
    assertFalse(gate.isStaleDetach("c1", 3))
    assertTrue(deliver(relay, attached(3)))
    assertTrue(deliver(relay, out("new-screen")))
    // Екран без attach за терминал без attach — detach-ът тръгва (безвреден).
    assertFalse(gate.isStaleDetach("c9", null))
  }

  /** detach по LAN, докато relay-ят носи потока: relay кадрите вече не минават. */
  @Test
  fun `detach по другия път спира и текущия път`() {
    attachedOnRelay()
    gate.attachSent(lan, 2, "c1")
    assertEquals(listOf(relay to "c1"), gate.detachSent(lan, "c1"))
    assertFalse(deliver(relay, out("relay-late")))
  }
}
