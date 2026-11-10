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
import com.idachev.supacoderemote.protocol.ResizeRequest
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.SizeChanged
import com.idachev.supacoderemote.protocol.SuggestRequest
import com.idachev.supacoderemote.protocol.Suggestions
import com.idachev.supacoderemote.protocol.TerminalBytes
import com.idachev.supacoderemote.protocol.TerminalKeys
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
    vm = TerminalViewModel(link, Notices(), "c1", suggestTimeoutMs = 5_000, nowMs = { dispatcher.scheduler.currentTime })
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
    advanceUntilIdle()
    vm.sendKey("\u0003")
    assertEquals(listOf("echo здравей 👋", "\r", "\u0003"), inputs())
  }

  @Test
  fun `Enter след текста от полето тръгва отделно и по-късно`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    assertTrue(vm.sendLine("hi"))
    runCurrent()
    assertEquals(listOf("hi"), inputs())
    advanceTimeBy(TerminalViewModel.ENTER_DELAY_MS + 1)
    assertEquals(listOf("hi", "\r"), inputs())
  }

  @Test
  fun `клавиш преди чакащия Enter не го изпреварва`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    vm.sendLine("hi")
    vm.sendKey("\u0003")
    advanceUntilIdle()
    assertEquals(listOf("hi", "\r", "\u0003"), inputs())
  }

  @Test
  fun `чакащ Enter тръгва при затваряне на екрана, преди detach`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    vm.sendLine("hi")
    store.clear()
    assertEquals(listOf("hi", "\r"), inputs())
    assertEquals(DetachRequest("c1"), link.sent.last())
  }

  @Test
  fun `празно поле праща само Enter веднага`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    assertTrue(vm.sendLine(""))
    assertEquals(listOf("\r"), inputs())
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
  fun `скрол отвъд историята иска скрол като от trackpad-а, само ако е включено`() = runTest(dispatcher) {
    var enabled = true
    val vm2 = TerminalViewModel(link, Notices(), "c1", suggestTimeoutMs = 5_000, overscrollToProgram = { enabled })
    store.put("vm2", vm2)
    link.hostSession.value = 1
    runCurrent()
    val commands = mutableListOf<TerminalCommand>()
    backgroundScope.launch { vm2.commands.collect { commands += it } }
    runCurrent()
    vm2.onOverscroll(up = true)
    runCurrent()
    assertTrue("без attach — нищо", commands.none { it is TerminalCommand.Wheel })
    vm2.onWebReady()
    emit(Attached(1, "c1", 120, 40))
    vm2.onOverscroll(up = true)
    vm2.onOverscroll(up = false)
    enabled = false
    vm2.onOverscroll(up = true)
    runCurrent()
    assertEquals(listOf(TerminalCommand.Wheel(true), TerminalCommand.Wheel(false)), commands.filterIsInstance<TerminalCommand.Wheel>())
    assertTrue("PgUp / PgDn вече не се пращат", inputs().isEmpty())
  }

  @Test
  fun `плаващите бутони искат скрол от страницата, а байтовете му отиват към PTY-то`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    val commands = collectCommands()
    vm.scrollWheel(up = true)
    vm.onWheelInput("")
    assertTrue("без attach — нищо", commands.none { it is TerminalCommand.Wheel })
    emit(Attached(1, "c1", 120, 40))
    vm.scrollWheel(up = true)
    vm.scrollWheel(up = false)
    vm.onWheelInput("\u001b[<64;61;21M")
    vm.onWheelInput("")
    runCurrent()
    assertEquals(listOf(TerminalCommand.Wheel(true), TerminalCommand.Wheel(false)), commands.filterIsInstance<TerminalCommand.Wheel>())
    assertEquals(listOf("\u001b[<64;61;21M"), inputs())
  }

  private val sgrDown = "\u001b[<65;61;21M"

  private fun TestScope.attachedWithCommands(): MutableList<TerminalCommand> {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    val commands = collectCommands()
    emit(Attached(1, "c1", 120, 40))
    commands.clear()
    return commands
  }

  private fun List<TerminalCommand>.jumpWheels() = filterIsInstance<TerminalCommand.Wheel>()

  /**
   * Страницата отговаря на всеки пакет с mouse report-и (програмата следи мишката), а
   * екранът се мени за първите [changingRounds] пакета — после е на дъното. Програмата може
   * да праща `out` и на дъното: важи само екранът.
   */
  private fun TestScope.respondToWheels(commands: List<TerminalCommand>, changingRounds: Int = Int.MAX_VALUE) {
    backgroundScope.launch {
      var seen = 0
      var reported = 0
      while (true) {
        val wheels = commands.jumpWheels().size
        if (wheels > seen) {
          seen = wheels
          vm.onWheelInput(sgrDown)
          vm.onWheelInput(sgrDown)
          link.messages.tryEmit(Output("c1", "eA=="))
        }
        val reports = commands.count { it is TerminalCommand.ReportScreen }
        if (reports > reported) {
          reported = reports
          vm.onScreenSignature(minOf(reports, changingRounds))
        }
        kotlinx.coroutines.delay(1)
      }
    }
  }

  @Test
  fun `„Най-долу“ скролира, докато идват нови редове, и спира, щом екранът спре да се мени`() = runTest(dispatcher) {
    val commands = attachedWithCommands()
    respondToWheels(commands, changingRounds = 7)
    vm.jumpToBottom()
    runCurrent()
    assertTrue(vm.state.value.jumping)
    advanceTimeBy(TerminalViewModel.JUMP_MAX_MS + 1_000)
    runCurrent()
    assertEquals(TerminalCommand.ScrollToBottom, commands.first())
    val wheels = commands.jumpWheels()
    // 7 пакета с промяна и още няколко, докато изтече времето без нови редове.
    assertTrue("пакети: ${wheels.size}", wheels.size in 9..13)
    assertTrue(wheels.all { !it.up && it.lines == TerminalViewModel.JUMP_LINES && it.programOnly })
    assertEquals(List(wheels.size * 2) { sgrDown }, inputs())
    assertFalse(vm.state.value.jumping)
  }

  @Test
  fun `„Най-долу“ при агент, който пише нови редове, спира на тавана`() = runTest(dispatcher) {
    val commands = attachedWithCommands()
    respondToWheels(commands)
    vm.jumpToBottom()
    advanceTimeBy(TerminalViewModel.JUMP_MAX_MS + 1_000)
    runCurrent()
    val atCap = commands.jumpWheels().size
    assertTrue("пакетите текат до тавана: $atCap", atCap > 50)
    advanceTimeBy(TerminalViewModel.JUMP_MAX_MS)
    runCurrent()
    assertEquals(atCap, commands.jumpWheels().size)
    assertFalse(vm.state.value.jumping)
  }

  @Test
  fun `второ докосване на „Най-долу“ го спира`() = runTest(dispatcher) {
    val commands = attachedWithCommands()
    respondToWheels(commands)
    vm.jumpToBottom()
    advanceTimeBy(TerminalViewModel.JUMP_EVERY_MS * 5)
    runCurrent()
    vm.jumpToBottom()
    runCurrent()
    assertFalse(vm.state.value.jumping)
    val stopped = commands.jumpWheels().size
    advanceTimeBy(TerminalViewModel.JUMP_MAX_MS)
    runCurrent()
    assertEquals(stopped, commands.jumpWheels().size)
  }

  @Test
  fun `„Най-долу“ спира след първия пакет, ако програмата не следи мишката`() = runTest(dispatcher) {
    val commands = attachedWithCommands()
    vm.jumpToBottom()
    advanceTimeBy(TerminalViewModel.JUMP_MAX_MS + 1_000)
    runCurrent()
    assertEquals(listOf(TerminalCommand.ScrollToBottom), commands.filter { it !is TerminalCommand.Wheel })
    assertEquals(1, commands.jumpWheels().size)
    assertTrue(inputs().isEmpty())
  }

  @Test
  fun `„Най-долу“ спира при вход от потребителя, а редът пак тръгва`() = runTest(dispatcher) {
    val commands = attachedWithCommands()
    respondToWheels(commands)
    vm.jumpToBottom()
    advanceTimeBy(TerminalViewModel.JUMP_EVERY_MS * 3)
    runCurrent()
    val before = commands.jumpWheels().size
    assertTrue(before >= 2)
    vm.sendKey("q")
    vm.onWheelInput(sgrDown)
    advanceTimeBy(TerminalViewModel.JUMP_MAX_MS)
    runCurrent()
    assertEquals(before, commands.jumpWheels().size)
    assertTrue("q" in inputs())
    assertFalse(vm.state.value.jumping)
  }

  @Test
  fun `„Най-долу“ спира при detached и при паднала връзка`() = runTest(dispatcher) {
    val commands = attachedWithCommands()
    vm.jumpToBottom()
    runCurrent()
    vm.onWheelInput(sgrDown)
    emit(Detached("c1", "край"))
    advanceTimeBy(TerminalViewModel.JUMP_MAX_MS)
    runCurrent()
    assertEquals(1, commands.jumpWheels().size)

    emit(Attached(2, "c1", 120, 40))
    commands.clear()
    vm.jumpToBottom()
    runCurrent()
    vm.onWheelInput(sgrDown)
    link.hostSession.value = null
    advanceTimeBy(TerminalViewModel.JUMP_MAX_MS)
    runCurrent()
    assertEquals(1, commands.jumpWheels().size)
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
  fun `нов изход докладва диапазона наново и ◀ ▶ тръгват от него`() = runTest(dispatcher) {
    vm.onWebReady()
    val commands = collectCommands()
    // Краят е на последния ред: без нов доклад ▶ спира тук.
    vm.onSelection(TerminalSelection(Cell(2, 4), Cell(9, 4), cols = 10, rows = 5))
    // Историята е изрязана с 2 реда, а буферът е пораснал: страницата казва новото място.
    vm.onSelection(TerminalSelection.of(Cell(2, 2), Cell(9, 2), cols = 10, rows = 8))
    vm.moveSelectionEnd(1)
    vm.moveSelectionStart(-1)
    runCurrent()
    assertEquals(TerminalSelection(Cell(1, 2), Cell(0, 3), cols = 10, rows = 8), vm.state.value.selection)
    assertEquals(
      listOf<TerminalCommand>(
        TerminalCommand.Select(Cell(2, 2), Cell(0, 3)),
        TerminalCommand.Select(Cell(1, 2), Cell(0, 3)),
      ),
      commands,
    )
    // Изрязано изцяло: лентата изчезва.
    vm.onSelection(null)
    assertEquals(null, vm.state.value.selection)
  }

  private val oneCell = TerminalSelection(Cell(1, 0), Cell(4, 0), cols = 10, rows = 3)

  private fun TestScope.attached(): MutableList<TerminalCommand> {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    val commands = collectCommands()
    emit(Attached(1, "c1", 10, 3))
    commands.clear()
    return commands
  }

  @Test
  fun `при маркирано изходът чака и след Копирай се пише по ред`() = runTest(dispatcher) {
    val commands = attached()
    vm.onSelection(oneCell)
    assertEquals(0L, vm.state.value.pausedBytes)
    emit(Output("c1", "aGk="))
    emit(Output("c1", "eA=="))
    assertTrue(commands.isEmpty())
    advanceTimeBy(TerminalViewModel.PAUSE_TICK_MS + 1)
    runCurrent()
    assertEquals(3L, vm.state.value.pausedBytes)
    vm.copySelection()
    runCurrent()
    assertEquals(
      listOf(TerminalCommand.CopySelection, TerminalCommand.Write("aGk="), TerminalCommand.Write("eA==")),
      commands,
    )
    assertEquals(null, vm.state.value.pausedBytes)
    emit(Output("c1", "YWJj"))
    assertEquals(TerminalCommand.Write("YWJj"), commands.last())
  }

  @Test
  fun `вход по време на пауза първо пише чакащото и отменя маркираното`() = runTest(dispatcher) {
    val commands = attached()
    vm.onSelection(oneCell)
    emit(Output("c1", "aGk="))
    vm.sendKey(TerminalKeys.PAGE_UP)
    runCurrent()
    assertEquals(listOf(TerminalCommand.ClearSelection, TerminalCommand.Write("aGk=")), commands)
    assertEquals(null, vm.state.value.selection)
    assertEquals(null, vm.state.value.pausedBytes)
    assertEquals(listOf(TerminalKeys.PAGE_UP), inputs())
  }

  @Test
  fun `над тавана паузата спира сама и маркираното се отменя`() = runTest(dispatcher) {
    store.clear()
    vm = TerminalViewModel(link, Notices(), "c1", suggestTimeoutMs = 5_000, pauseCapBytes = 3)
    store = ViewModelStore().also { it.put("vm", vm) }
    val commands = attached()
    vm.onSelection(oneCell)
    emit(Output("c1", "YWJj"))
    assertTrue(commands.isEmpty())
    emit(Output("c1", "eA=="))
    assertEquals(
      listOf(TerminalCommand.ClearSelection, TerminalCommand.Write("YWJj"), TerminalCommand.Write("eA==")),
      commands,
    )
    assertEquals(null, vm.state.value.selection)
    assertEquals(null, vm.state.value.pausedBytes)
  }

  @Test
  fun `size по време на пауза първо пише чакащото, после преоразмерява`() = runTest(dispatcher) {
    val commands = attached()
    vm.onSelection(oneCell)
    emit(Output("c1", "aGk="))
    emit(SizeChanged("c1", 12, 4))
    assertEquals(
      listOf(TerminalCommand.ClearSelection, TerminalCommand.Write("aGk="), TerminalCommand.Resize(12, 4)),
      commands,
    )
    assertEquals(null, vm.state.value.selection)
  }

  @Test
  fun `изчезнало маркирано в страницата пуска чакащото`() = runTest(dispatcher) {
    val commands = attached()
    vm.onSelection(oneCell)
    emit(Output("c1", "aGk="))
    vm.onSelection(null)
    runCurrent()
    assertEquals(listOf<TerminalCommand>(TerminalCommand.Write("aGk=")), commands)
  }

  @Test
  fun `при затваряне на екрана се праща detach`() = runTest(dispatcher) {
    runCurrent()
    store.clear()
    assertEquals(DetachRequest("c1"), link.sent.last())
  }

  @Test
  fun `по подразбиране двете ленти са скрити и терминалът е на цял екран`() {
    assertEquals(TerminalBars(topBar = false, input = false), vm.state.value.bars)
  }

  @Test
  fun `бутоните показват и скриват лентите, без да пращат нищо към PTY-то`() = runTest(dispatcher) {
    vm.toggleTopBar()
    assertTrue(vm.state.value.bars.topBar)
    vm.setInputShown(true)
    assertTrue(vm.state.value.bars.input)
    vm.toggleTopBar()
    vm.setInputShown(false)
    assertEquals(TerminalBars(), vm.state.value.bars)
    runCurrent()
    assertTrue(link.sent.isEmpty())
  }

  @Test
  fun `следващият таб тръгва със скрити ленти, дори предишният да е оставен с показани`() {
    val first = TerminalViewModel(link, Notices(), "c1")
    store.put("first", first)
    first.toggleTopBar()
    first.setInputShown(true)
    val second = TerminalViewModel(link, Notices(), "c2")
    store.put("second", second)
    assertEquals(TerminalBars(topBar = false, input = false), second.state.value.bars)
    assertEquals(TerminalBars(topBar = true, input = true), first.state.value.bars)
  }

  @Test
  fun `Размер по този екран пита страницата и праща resize с нейния размер`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    val commands = collectCommands()
    emit(Attached(1, "c1", 120, 40))
    vm.fitToScreen()
    runCurrent()
    assertTrue(TerminalCommand.MeasureGrid in commands)
    vm.onGrid(64, 38)
    assertEquals(ResizeRequest("c1", 64, 38), link.sent.last())
  }

  @Test
  fun `без attach размерът от страницата не тръгва`() = runTest(dispatcher) {
    vm.onGrid(64, 38)
    assertTrue(link.sent.none { it is ResizeRequest })
  }

  @Test
  fun `size със същия размер пак преоразмерява страницата`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    val commands = collectCommands()
    emit(Attached(1, "c1", 120, 40))
    emit(SizeChanged("c1", 120, 40))
    emit(SizeChanged("c1", 120, 40))
    assertEquals(
      listOf(TerminalCommand.Init(120, 40), TerminalCommand.Resize(120, 40), TerminalCommand.Resize(120, 40)),
      commands,
    )
  }

  @Test
  fun `resize_failed за този таб освобождава чакащия размер в страницата`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    val commands = collectCommands()
    emit(Attached(1, "c1", 120, 40))
    vm.onGrid(64, 38)
    emit(ErrorReply(null, "terminal not ready", code = ErrorReply.RESIZE_FAILED, contentId = "c1"))
    assertEquals(listOf(TerminalCommand.Init(120, 40), TerminalCommand.ResizeFailed), commands)
    // Терминалът остава закачен със стария размер: грешката е само за размера.
    assertEquals(AttachPhase.Attached(120, 40), vm.state.value.phase)
  }

  @Test
  fun `resize_failed за друг таб или друга грешка не пипа размера`() = runTest(dispatcher) {
    link.hostSession.value = 1
    runCurrent()
    vm.onWebReady()
    val commands = collectCommands()
    emit(Attached(1, "c1", 120, 40))
    emit(ErrorReply(null, "gone", code = ErrorReply.RESIZE_FAILED, contentId = "other"))
    emit(ErrorReply(null, "boom", code = "brand_new", contentId = "c1"))
    assertEquals(listOf<TerminalCommand>(TerminalCommand.Init(120, 40)), commands)
  }
}
