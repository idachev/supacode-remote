package com.idachev.supacoderemote.terminal

import androidx.lifecycle.ViewModelStore
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.AttachRequest
import com.idachev.supacoderemote.protocol.Attached
import com.idachev.supacoderemote.protocol.ClientMessage
import com.idachev.supacoderemote.protocol.DetachRequest
import com.idachev.supacoderemote.protocol.Detached
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.InputRequest
import com.idachev.supacoderemote.protocol.Output
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.SizeChanged
import com.idachev.supacoderemote.protocol.SuggestRequest
import com.idachev.supacoderemote.protocol.Suggestions
import com.idachev.supacoderemote.protocol.TerminalBytes
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TerminalViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  private class FakeLink : HostLink {
    override val messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    override val hostSession = MutableStateFlow<Int?>(null)
    val sent = mutableListOf<ClientMessage>()
    var up = true
    private var id = 0

    override fun send(message: ClientMessage): Boolean {
      if (!up) return false
      sent += message
      return true
    }

    override fun nextId(): Int = ++id
  }

  private lateinit var link: FakeLink
  private lateinit var store: ViewModelStore
  private lateinit var vm: TerminalViewModel

  @Before
  fun setUp() {
    Dispatchers.setMain(dispatcher)
    link = FakeLink()
    store = ViewModelStore()
    vm = TerminalViewModel(link, Notices(), "c1", suggestTimeoutMs = 5_000)
    store.put("vm", vm)
  }

  @After
  fun tearDown() {
    Dispatchers.resetMain()
  }

  private fun TestScope.emit(message: ServerMessage) {
    link.messages.tryEmit(message)
    runCurrent()
  }

  private fun TestScope.collectCommands(): MutableList<TerminalCommand> {
    val out = mutableListOf<TerminalCommand>()
    backgroundScope.launch { vm.commands.collect { out += it } }
    runCurrent()
    return out
  }

  private fun inputs(): List<String> =
    link.sent.filterIsInstance<InputRequest>().map { TerminalBytes.decode(it.b64).decodeToString() }

  @Test
  fun `Копирай иска текста от страницата и не праща нищо към PTY-то`() = runTest(dispatcher) {
    vm.onWebReady()
    val commands = collectCommands()
    vm.requestText()
    runCurrent()
    assertEquals(listOf<TerminalCommand>(TerminalCommand.RequestText), commands)
    assertTrue(link.sent.none { it is InputRequest })
  }

  @Test
  fun `attach тръгва, щом има и страница, и онлайн host`() = runTest(dispatcher) {
    runCurrent()
    vm.onWebReady()
    assertTrue(link.sent.isEmpty())
    link.hostSession.value = 1
    runCurrent()
    val attach = link.sent.single() as AttachRequest
    assertEquals("c1", attach.contentId)
    assertEquals(500, attach.scrollback)
    assertEquals(AttachPhase.Attaching, vm.state.value.phase)
  }

  @Test
  fun `attached дава точния размер, после out и size в ред`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    val commands = collectCommands()
    emit(Attached(1, "c1", 120, 40))
    emit(Output("c1", "aGk="))
    emit(Output("other", "eA=="))
    emit(SizeChanged("c1", 100, 30))
    assertEquals(
      listOf(TerminalCommand.Init(120, 40), TerminalCommand.Write("aGk="), TerminalCommand.Resize(100, 30)),
      commands,
    )
    assertEquals(AttachPhase.Attached(100, 30), vm.state.value.phase)
  }

  @Test
  fun `след като host-ът падне и се върне, attach се праща наново`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    link.hostSession.value = null
    runCurrent()
    assertEquals(AttachPhase.Waiting, vm.state.value.phase)
    link.hostSession.value = 2
    runCurrent()
    assertEquals(2, link.sent.filterIsInstance<AttachRequest>().size)
  }

  @Test
  fun `смяна на пътя LAN към relay без прекъсване пак прави attach`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    // RelayClient вдига сесията направо от 1 на 2, когато LAN падне, а relay-ът е горе.
    link.hostSession.value = 2
    runCurrent()
    assertEquals(2, link.sent.filterIsInstance<AttachRequest>().size)
  }

  @Test
  fun `detached показва причината и „Свържи отново“ прави нов attach`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    emit(Detached("c1", "session ended"))
    assertEquals(AttachPhase.Detached("session ended"), vm.state.value.phase)
    vm.reattach()
    assertEquals(2, link.sent.filterIsInstance<AttachRequest>().size)
  }

  @Test
  fun `текстът отива с Enter, а клавишите — както са`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    assertTrue(vm.sendLine("echo здравей 👋"))
    vm.sendKey("\u0003")
    assertEquals(listOf("echo здравей 👋\r", "\u0003"), inputs())
  }

  @Test
  fun `лепкавият Ctrl превръща следващата буква в control код веднъж`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    vm.toggleCtrl()
    assertTrue(vm.consumeCtrl('c'))
    assertFalse(vm.state.value.ctrlSticky)
    assertFalse(vm.consumeCtrl('c'))
    vm.toggleCtrl()
    assertTrue(vm.consumeCtrl('d'))
    vm.toggleCtrl()
    assertFalse(vm.consumeCtrl('1'))
    assertTrue(vm.state.value.ctrlSticky)
    vm.sendKey("\t")
    assertFalse(vm.state.value.ctrlSticky)
    assertEquals(listOf("\u0003", "\u0004", "\t"), inputs())
  }

  @Test
  fun `живите клавиши минават през лепкавия Ctrl`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    vm.setLiveKeys(true)
    assertTrue(vm.state.value.liveKeys)
    vm.sendLive("y")
    vm.toggleCtrl()
    vm.sendLive("c")
    vm.sendLive("ж\u007f\r")
    assertEquals(listOf("y", "\u0003", "ж\u007f\r"), inputs())
  }

  @Test
  fun `скрол отвъд историята праща PgUp и PgDn, само ако е включено`() = runTest(dispatcher) {
    var enabled = true
    val vm2 = TerminalViewModel(link, Notices(), "c1", suggestTimeoutMs = 5_000, overscrollToProgram = { enabled })
    store.put("vm2", vm2)
    link.hostSession.value = 1
    runCurrent()
    vm2.onOverscroll(up = true)
    assertTrue("без attach — нищо", inputs().isEmpty())
    vm2.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    vm2.onOverscroll(up = true)
    vm2.onOverscroll(up = false)
    enabled = false
    vm2.onOverscroll(up = true)
    assertEquals(listOf("\u001b[5~", "\u001b[6~"), inputs())
  }

  @Test
  fun `без attach нищо не се пише`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    assertFalse(vm.sendLine("ls"))
    assertTrue(inputs().isEmpty())
  }

  @Test
  fun `предложенията само се показват и никога не се пращат`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    vm.suggest()
    val request = link.sent.filterIsInstance<SuggestRequest>().single()
    assertTrue(vm.state.value.suggesting)
    emit(Suggestions(request.id, "c1", listOf("git status", "/btw")))
    assertFalse(vm.state.value.suggesting)
    assertEquals(listOf("git status", "/btw"), vm.state.value.suggestions)
    advanceUntilIdle()
    assertTrue(inputs().isEmpty())
  }

  @Test
  fun `грешка или изтекло време спират чакането на предложения`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.suggest()
    val first = link.sent.filterIsInstance<SuggestRequest>().single()
    emit(ErrorReply(first.id, "claude failed"))
    assertFalse(vm.state.value.suggesting)
    vm.suggest()
    assertTrue(vm.state.value.suggesting)
    advanceTimeBy(5_001)
    runCurrent()
    assertFalse(vm.state.value.suggesting)
  }

  @Test
  fun `маркираното се нагласява с ◀ ▶ и страницата показва точно него`() = runTest(dispatcher) {
    vm.onWebReady()
    val commands = collectCommands()
    vm.onSelection(TerminalSelection(Cell(9, 1), Cell(2, 2), cols = 10, rows = 3))
    vm.moveSelectionStart(1)
    vm.moveSelectionEnd(1)
    runCurrent()
    val shown = TerminalSelection(Cell(0, 2), Cell(3, 2), cols = 10, rows = 3)
    assertEquals(shown, vm.state.value.selection)
    assertEquals(
      listOf<TerminalCommand>(
        TerminalCommand.Select(Cell(0, 2), Cell(2, 2)),
        TerminalCommand.Select(Cell(0, 2), Cell(3, 2)),
      ),
      commands,
    )
    assertTrue(link.sent.none { it is InputRequest })
  }

  @Test
  fun `крачка в стената не праща нищо към страницата`() = runTest(dispatcher) {
    vm.onWebReady()
    val commands = collectCommands()
    vm.onSelection(TerminalSelection(Cell(0, 0), Cell(0, 0), cols = 10, rows = 3))
    vm.moveSelectionStart(-1)
    vm.moveSelectionStart(1)
    vm.moveSelectionEnd(-1)
    runCurrent()
    assertTrue(commands.isEmpty())
  }

  @Test
  fun `Копирай и Отказ махат лентата, а без маркирано ◀ ▶ не правят нищо`() = runTest(dispatcher) {
    vm.onWebReady()
    val commands = collectCommands()
    vm.moveSelectionEnd(1)
    vm.copySelection()
    runCurrent()
    assertTrue(commands.isEmpty())
    vm.onSelection(TerminalSelection(Cell(1, 0), Cell(4, 0), cols = 10, rows = 3))
    vm.copySelection()
    runCurrent()
    assertEquals(null, vm.state.value.selection)
    vm.onSelection(TerminalSelection(Cell(1, 0), Cell(4, 0), cols = 10, rows = 3))
    vm.clearSelection()
    runCurrent()
    assertEquals(null, vm.state.value.selection)
    assertEquals(listOf(TerminalCommand.CopySelection, TerminalCommand.ClearSelection), commands)
    vm.onSelection(TerminalSelection(Cell(1, 0), Cell(4, 0), cols = 10, rows = 3))
    vm.onSelection(null)
    assertEquals(null, vm.state.value.selection)
  }

  @Test
  fun `при затваряне на екрана се праща detach`() = runTest(dispatcher) {
    runCurrent()
    store.clear()
    assertEquals(DetachRequest("c1"), link.sent.last())
  }
}
