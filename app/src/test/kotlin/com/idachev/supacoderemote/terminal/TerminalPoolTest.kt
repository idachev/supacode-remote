package com.idachev.supacoderemote.terminal

import android.content.ComponentCallbacks2
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.AttachRequest
import com.idachev.supacoderemote.protocol.Attached
import com.idachev.supacoderemote.protocol.ClientMessage
import com.idachev.supacoderemote.protocol.DetachRequest
import com.idachev.supacoderemote.protocol.Detached
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.ListReply
import com.idachev.supacoderemote.protocol.Output
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.SizeChanged
import com.idachev.supacoderemote.protocol.Tab
import com.idachev.supacoderemote.protocol.Worktree
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TerminalPoolTest {

  private class FakeLink : HostLink {
    override val messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    override val hostSession = MutableStateFlow<Int?>(1)
    override val hostCaps = MutableStateFlow<Set<String>?>(setOf("watch", "attach.keep"))
    val sent = mutableListOf<ClientMessage>()

    /** Редът на attach-овете и на detach-овете по другите пътища (ПБ1). */
    val order = mutableListOf<String>()
    private var id = 0

    override fun send(message: ClientMessage): Boolean {
      sent += message
      if (message is AttachRequest) order += "attach ${message.contentId}"
      return true
    }

    override fun detachOtherPaths(contentId: String) {
      order += "other $contentId"
    }

    override fun nextId(): Int = ++id
  }

  private val dispatcher = StandardTestDispatcher()
  private val link = FakeLink()
  private val hostChanges = MutableStateFlow<Any?>("office")

  /** Часовникът на пула; отделно от времето на dispatcher-а, за замразен процес във фон. */
  private var now = 0L
  private val pool = TerminalPool(
    link,
    Notices(),
    CoroutineScope(SupervisorJob() + dispatcher),
    hiddenCapBytes = 1024,
    resets = hostChanges,
    nowMs = { now },
  )

  private fun TestScope.emit(message: ServerMessage) {
    link.messages.tryEmit(message)
    runCurrent()
  }

  private fun attaches(contentId: String): List<AttachRequest> =
    link.sent.filterIsInstance<AttachRequest>().filter { it.contentId == contentId }

  private fun detaches(): List<String> = link.sent.filterIsInstance<DetachRequest>().map { it.contentId }

  /** Екранът на таба: страницата е готова, Mac-ът отговаря с attached. Връща собственика. */
  private fun TestScope.enter(contentId: String): Any {
    val owner = Any()
    val session = pool.open(contentId, owner)
    runCurrent()
    session.onWebReady()
    runCurrent()
    attaches(contentId).lastOrNull()?.let { emit(Attached(it.id, contentId, 80, 24)) }
    return owner
  }

  /** Отваряне и излизане — табът остава скрит в пула. */
  private fun TestScope.visit(contentId: String) {
    val owner = enter(contentId)
    pool.leave(contentId, owner)
    runCurrent()
  }

  private fun ids(): List<String> = pool.sessions.map { it.contentId }

  @Test
  fun `петият таб пуска най-отдавна видяния`() = runTest(dispatcher) {
    listOf("A", "B", "C", "D", "E").forEach { visit(it) }
    assertEquals(listOf("A"), detaches())
    assertEquals(listOf("E", "D", "C", "B"), ids())
  }

  @Test
  fun `attach носи keep при attach keep в caps`() = runTest(dispatcher) {
    visit("A")
    assertEquals(true, attaches("A").single().keep)
  }

  @Test
  fun `връщане към таб от пула не праща attach`() = runTest(dispatcher) {
    visit("A")
    visit("B")
    val sentBefore = link.sent.size
    val session = pool.open("A", Any())
    runCurrent()
    assertEquals(sentBefore, link.sent.size)
    assertEquals(AttachPhase.Attached(80, 24), session.state.value.phase)
    assertEquals(listOf("A", "B"), ids())
  }

  @Test
  fun `нова сесия прави attach само на видимия`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    link.hostSession.value = 2
    runCurrent()
    assertEquals(2, attaches("B").size)
    assertEquals(1, attaches("A").size)
  }

  /** ПБ1 (ДЗ8a): relay → LAN без видим таб — скритите не текат по relay-а до следващия attached. */
  @Test
  fun `нова сесия без видим таб пуска скритите по другите пътища`() = runTest(dispatcher) {
    visit("A")
    visit("B")
    link.order.clear()
    link.hostSession.value = 2
    runCurrent()
    assertEquals(listOf("other B", "other A"), link.order)
    pool.open("A", Any())
    runCurrent()
    assertEquals(listOf("other B", "other A", "attach A"), link.order)
  }

  /** Видимият първо прави attach по новия път; неговият стар път спира gate-ът (АЦ2), не тук. */
  @Test
  fun `нова сесия - attach на видимия, после detach на скритите`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    link.order.clear()
    link.hostSession.value = 2
    runCurrent()
    assertEquals(listOf("attach B", "other A"), link.order)
  }

  @Test
  fun `size на скрит таб без attach не го прави свързан`() = runTest(dispatcher) {
    visit("A")
    val session = pool.sessions.single()
    link.hostSession.value = 2
    runCurrent()
    assertEquals(AttachPhase.Waiting, session.state.value.phase)
    emit(SizeChanged("A", 100, 30))
    assertEquals(AttachPhase.Waiting, session.state.value.phase)
  }

  @Test
  fun `скрит таб при връщане след нова сесия прави attach`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    link.hostSession.value = 2
    runCurrent()
    pool.open("A", Any())
    runCurrent()
    assertEquals(2, attaches("A").size)
    assertEquals(true, attaches("A").last().keep)
  }

  @Test
  fun `фон пуска скритите и ги маркира за attach`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    pool.backgrounded()
    runCurrent()
    assertEquals(listOf("A"), detaches())
    assertEquals(listOf("B", "A"), ids())
    pool.open("A", Any())
    runCurrent()
    assertEquals(2, attaches("A").size)
  }

  private fun listWith(vararg contentIds: String) = ListReply(
    id = null,
    repos = listOf(
      Repository(
        id = "r",
        name = "r",
        worktrees = listOf(Worktree(id = "w", name = "w", tabs = contentIds.map { Tab(id = "t-$it", contentId = it) })),
      ),
    ),
  )

  @Test
  fun `скрит таб, изчезнал от list, получава detach`() = runTest(dispatcher) {
    visit("A")
    visit("C")
    enter("B")
    // Видимият B също липсва (стар list преди новия таб) — той остава. A липсва в два поредни.
    emit(listWith("C"))
    emit(listWith("C"))
    assertEquals(listOf("A"), detaches())
    assertEquals(listOf("B", "C"), ids())
    // Без сесия с host-а list-ът е закъснял от стария — не се гледа.
    link.hostSession.value = null
    runCurrent()
    emit(listWith())
    emit(listWith())
    assertEquals(listOf("B", "C"), ids())
  }

  /** F4: list, поискан преди таба да съществува, може да дойде след отварянето му. */
  @Test
  fun `един стар list без таба не го пуска, два поредни — пускат`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    emit(listWith("B"))
    assertEquals(listOf("B", "A"), ids())
    // Табът се появява — броячът се нулира.
    emit(listWith("A", "B"))
    emit(listWith("B"))
    assertEquals(listOf("B", "A"), ids())
    emit(listWith("B"))
    assertEquals(listOf("A"), detaches())
    assertEquals(listOf("B"), ids())
  }

  @Test
  fun `detached за скрит таб го маха от пула`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    emit(Detached("A", "session ended"))
    assertEquals(listOf("B"), ids())
    // За видимия — както днес: остава, а екранът показва „Свържи отново“.
    emit(Detached("B", "session ended"))
    assertEquals(listOf("B"), ids())
    assertEquals(AttachPhase.Detached("session ended"), pool.sessions.single().state.value.phase)
  }

  @Test
  fun `attach_limit свива пула до видимия`() = runTest(dispatcher) {
    visit("A")
    visit("B")
    val owner = Any()
    val c = pool.open("C", owner)
    c.onWebReady()
    runCurrent()
    val attachC = attaches("C").single()
    emit(ErrorReply(attachC.id, "too many attached terminals", ErrorReply.ATTACH_LIMIT, "C"))
    assertEquals(listOf("B", "A"), detaches())
    assertEquals(listOf("C"), ids())
    assertEquals(2, attaches("C").size)
    assertEquals(AttachPhase.Attaching, c.state.value.phase)
    // Втори отказ: без нов опит, екранът показва грешката.
    emit(ErrorReply(attaches("C").last().id, "too many attached terminals", ErrorReply.ATTACH_LIMIT, "C"))
    assertEquals(2, attaches("C").size)
    assertEquals(AttachPhase.Detached("too many attached terminals"), c.state.value.phase)
  }

  @Test
  fun `без attach keep в caps пулът е само видимият`() = runTest(dispatcher) {
    link.hostCaps.value = emptySet()
    val ownerA = enter("A")
    assertEquals(null, attaches("A").single().keep)
    pool.leave("A", ownerA)
    runCurrent()
    assertEquals(listOf("A"), detaches())
    enter("B")
    assertEquals(listOf("B"), ids())
  }

  @Test
  fun `без attach keep отварянето пуска другите`() = runTest(dispatcher) {
    visit("A")
    link.hostCaps.value = emptySet()
    enter("B")
    assertEquals(listOf("A"), detaches())
    assertEquals(listOf("B"), ids())
  }

  @Test
  fun `бърза смяна не праща detach за таб от набора`() = runTest(dispatcher) {
    listOf("A", "B", "A", "B").forEach { visit(it) }
    assertEquals(emptyList<String>(), detaches())
  }

  /** Старият екран на A се затваря чак след като новият екран на A е отворил същия таб. */
  @Test
  fun `късно затваряне на стар екран не пуска таба на новия`() = runTest(dispatcher) {
    link.hostCaps.value = emptySet()
    val oldOwner = enter("A")
    val session = pool.open("A", Any())
    pool.leave("A", oldOwner)
    runCurrent()
    assertEquals(emptyList<String>(), detaches())
    assertEquals(listOf("A"), ids())
    assertTrue(session.visible)
  }

  @Test
  fun `изходът на скрит отива в буфера, при показване в commands`() = runTest(dispatcher) {
    visit("A")
    val session = pool.sessions.single()
    val commands = mutableListOf<TerminalCommand>()
    backgroundScope.launch { session.commands.collect { commands += it } }
    runCurrent()
    commands.clear()
    emit(Output("A", "YQ=="))
    emit(SizeChanged("A", 100, 30))
    emit(Output("A", "Yg=="))
    assertEquals(emptyList<TerminalCommand>(), commands)
    // Размерът се знае веднага (заглавието), само страницата чака.
    assertEquals(AttachPhase.Attached(100, 30), session.state.value.phase)
    assertSame(session, pool.open("A", Any()))
    runCurrent()
    assertEquals(
      listOf(TerminalCommand.Resize(100, 30), TerminalCommand.Write("YQ=="), TerminalCommand.Write("Yg==")),
      commands,
    )
  }

  @Test
  fun `препълнен скрит буфер прави attach при показване`() = runTest(dispatcher) {
    visit("A")
    emit(Output("A", "x".repeat(2_000)))
    pool.open("A", Any())
    runCurrent()
    assertEquals(2, attaches("A").size)
  }

  @Test
  fun `attach без keep маркира другите за attach`() = runTest(dispatcher) {
    visit("A")
    // Нов сокет без hello: caps още не са известни, затова attach-ът е без keep и Mac-ът
    // откача другите по тази връзка.
    link.hostCaps.value = null
    enter("B")
    assertEquals(null, attaches("B").single().keep)
    assertEquals(listOf("B", "A"), ids())
    pool.open("A", Any())
    runCurrent()
    assertEquals(2, attaches("A").size)
  }

  @Test
  fun `5 min във фон свиват пула`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    pool.backgrounded()
    advanceTimeBy(TerminalPool.BACKGROUND_SHRINK_MS - 1)
    runCurrent()
    assertEquals(listOf("B", "A"), ids())
    advanceTimeBy(2)
    runCurrent()
    // Видимият остава: неговото WebView е на екрана, когато приложението се върне.
    assertEquals(listOf("B"), ids())
  }

  @Test
  fun `връщане преди 5 min не свива пула`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    pool.backgrounded()
    advanceTimeBy(TerminalPool.BACKGROUND_SHRINK_MS - 60_000)
    now = TerminalPool.BACKGROUND_SHRINK_MS - 60_000
    pool.foregrounded()
    advanceTimeBy(120_000)
    runCurrent()
    assertEquals(listOf("B", "A"), ids())
  }

  /** Замразен във фон процес не върти таймери: часовникът решава при връщането. */
  @Test
  fun `след 5 min във фон по часовника пулът се свива при връщане`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    pool.backgrounded()
    now = TerminalPool.BACKGROUND_SHRINK_MS + 1
    pool.foregrounded()
    runCurrent()
    assertEquals(listOf("B"), ids())
  }

  @Test
  fun `недостиг на памет свива пула, скриването на UI не`() {
    assertTrue(TerminalPool.shrinksOnTrim(ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW))
    assertTrue(TerminalPool.shrinksOnTrim(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL))
    assertTrue(TerminalPool.shrinksOnTrim(ComponentCallbacks2.TRIM_MEMORY_MODERATE))
    assertTrue(TerminalPool.shrinksOnTrim(ComponentCallbacks2.TRIM_MEMORY_COMPLETE))
    assertFalse(TerminalPool.shrinksOnTrim(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE))
    assertFalse(TerminalPool.shrinksOnTrim(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN))
    assertFalse(TerminalPool.shrinksOnTrim(ComponentCallbacks2.TRIM_MEMORY_BACKGROUND))
  }

  /**
   * F3: страницата на скрит таб се е заредила чак след като екранът е излязъл. Attach оттук би
   * бил без keep при неизвестни caps и би спрял видимия — тръгва при показване.
   */
  @Test
  fun `страница, заредена докато табът е скрит, не прави attach`() = runTest(dispatcher) {
    val owner = Any()
    val a = pool.open("A", owner)
    pool.leave("A", owner)
    runCurrent()
    a.onWebReady()
    runCurrent()
    assertEquals(emptyList<AttachRequest>(), attaches("A"))
    pool.open("A", Any())
    runCurrent()
    assertEquals(1, attaches("A").size)
  }

  @Test
  fun `смяна на Mac-а изчиства пула`() = runTest(dispatcher) {
    visit("A")
    enter("B")
    hostChanges.value = "home"
    runCurrent()
    assertEquals(emptyList<String>(), ids())
    assertFalse(pool.sessions.any())
  }
}
