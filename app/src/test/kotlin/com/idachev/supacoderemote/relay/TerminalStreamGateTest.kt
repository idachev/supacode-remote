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

  // ---- attach keep: няколко терминала на един път (ДЗ14–ДЗ16) ----

  private fun attachedFor(id: Int, contentId: String) = Attached(id = id, contentId = contentId, cols = 80, rows = 24)

  /** A и B са живи по relay-а с keep: A е видимият, B — скритият. */
  private fun twoKeptOnRelay() {
    gate.attachSent(relay, 1, "A", keep = true)
    assertTrue(deliver(relay, attachedFor(1, "A")))
    gate.attachSent(relay, 2, "B", keep = true)
    assertTrue(deliver(relay, attachedFor(2, "B")))
  }

  @Test
  fun `два терминала с keep на един път текат заедно`() {
    twoKeptOnRelay()
    assertTrue(deliver(relay, Output("A", "a")))
    assertTrue(deliver(relay, Output("B", "b")))
    assertTrue(gate.isAttached("A"))
    assertTrue(gate.isAttached("B"))
  }

  @Test
  fun `attach без keep на пътя спира другите терминали там`() {
    twoKeptOnRelay()
    gate.attachSent(relay, 3, "C")
    assertFalse(deliver(relay, Output("A", "a")))
    assertFalse(deliver(relay, Output("B", "b")))
    assertFalse(gate.isAttached("A"))
    assertTrue(deliver(relay, attachedFor(3, "C")))
    assertTrue(deliver(relay, Output("C", "c")))
  }

  /** RF1: щом видимият е по LAN, по relay-а не остава нито един attach — и скритите (ДЗ8a). */
  @Test
  fun `след LAN attached на видимия скритите на relay-а получават detach`() {
    twoKeptOnRelay()
    gate.attachSent(lan, 3, "A", keep = true)
    val handoff = gate.accept(lan, attachedFor(3, "A"))
    assertTrue(handoff.deliver)
    assertEquals(listOf(relay to "A", relay to "B"), handoff.detach)
    assertFalse(deliver(relay, Output("B", "hidden-late")))
    assertFalse(deliver(relay, Output("A", "relay-late")))
    assertTrue(deliver(lan, Output("A", "lan-live")))
    assertFalse(gate.isAttached("B"))
  }

  @Test
  fun `изходът на видимия по relay тече до LAN attached`() {
    twoKeptOnRelay()
    gate.attachSent(lan, 3, "A", keep = true)
    assertTrue(deliver(relay, Output("A", "gap")))
    assertTrue(deliver(relay, Output("B", "hidden")))
    // Кадър на A по LAN преди неговия attached (стар поток) не минава.
    assertFalse(deliver(lan, Output("A", "early")))
  }

  @Test
  fun `closed на пътя маха всички терминали по него`() {
    twoKeptOnRelay()
    gate.closed(relay)
    assertFalse(gate.isAttached("A"))
    assertFalse(gate.isAttached("B"))
    assertFalse(deliver(relay, Output("A", "a")))
    assertFalse(deliver(relay, Output("B", "b")))
  }

  /** RF4: detach на скрития спира само него. */
  @Test
  fun `закъснял detach на скрит не спира видимия`() {
    twoKeptOnRelay()
    assertEquals(emptyList<Pair<Any, String>>(), gate.detachSent(relay, "B"))
    assertTrue(deliver(relay, Output("A", "a")))
    assertFalse(deliver(relay, Output("B", "b")))
    assertTrue(gate.isAttached("A"))
    assertFalse(gate.isAttached("B"))
  }

  /**
   * Скритият B е тръгнал с attach по relay-а, но още без отговор, когато видимият A мине на LAN.
   * detach-ът по relay-а отменя и него: закъснелият му `attached` там не бива да стане текущ и да
   * спре A по LAN.
   */
  @Test
  fun `detach при смяна на пътя отменя и чакащия attach там`() {
    gate.attachSent(relay, 1, "A", keep = true)
    assertTrue(deliver(relay, attachedFor(1, "A")))
    gate.attachSent(relay, 2, "B", keep = true)
    gate.attachSent(lan, 3, "A", keep = true)
    assertEquals(listOf(relay to "A", relay to "B"), gate.accept(lan, attachedFor(3, "A")).detach)
    val late = gate.accept(relay, attachedFor(2, "B"))
    assertFalse(late.deliver)
    assertEquals(emptyList<Pair<Any, String>>(), late.detach)
    assertTrue(deliver(lan, Output("A", "lan-live")))
    assertTrue(gate.isAttached("A"))
  }

  /**
   * ДЗ14: detach по стария път е само за терминала, чийто attached е дошъл. A също сменя пътя
   * (чака attached по LAN) и тече по relay-а дотогава; attached на B не бива да го откачи там.
   */
  @Test
  fun `attached на друг терминал не откача терминал, който сменя пътя`() {
    twoKeptOnRelay()
    gate.attachSent(lan, 3, "A", keep = true)
    gate.attachSent(lan, 4, "B", keep = true)
    assertEquals(listOf(relay to "B"), gate.accept(lan, attachedFor(4, "B")).detach)
    assertTrue(deliver(relay, Output("A", "gap")))
    assertEquals(listOf(relay to "A"), gate.accept(lan, attachedFor(3, "A")).detach)
    assertFalse(deliver(relay, Output("A", "late")))
    assertTrue(deliver(lan, Output("A", "lan-live")))
  }

  /**
   * ПБ1 (ДЗ8a): нова сесия по LAN — скритият B получава detach по relay-а веднага, а видимият A
   * тече по relay-а до своя attached по LAN (АЦ2).
   */
  @Test
  fun `detach на скрит по другите пътища не пипа текущия път`() {
    twoKeptOnRelay()
    gate.attachSent(lan, 3, "A", keep = true)
    assertEquals(listOf(relay to "B"), gate.takeOtherPaths("B", current = lan))
    assertFalse(deliver(relay, Output("B", "hidden-late")))
    assertFalse(gate.isAttached("B"))
    assertTrue(deliver(relay, Output("A", "gap")))
    assertEquals(listOf(relay to "A"), gate.accept(lan, attachedFor(3, "A")).detach)
    // По текущия път нищо не се маха: hostOnline false → true на същия сокет.
    gate.attachSent(lan, 4, "C", keep = true)
    assertTrue(deliver(lan, attachedFor(4, "C")))
    assertEquals(emptyList<Pair<Any, String>>(), gate.takeOtherPaths("C", current = lan))
    assertTrue(deliver(lan, Output("C", "c")))
  }

  /** Както днес с един чакащ attach: attach без keep отменя чакащия attach на друг терминал по пътя. */
  @Test
  fun `attach без keep отменя чакащия attach на друг терминал по същия път`() {
    gate.attachSent(relay, 1, "A", keep = true)
    gate.attachSent(relay, 2, "B")
    assertFalse(gate.isAttached("A"))
    assertFalse(deliver(relay, attachedFor(1, "A")))
    assertTrue(deliver(relay, attachedFor(2, "B")))
    assertTrue(deliver(relay, Output("B", "b")))
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
