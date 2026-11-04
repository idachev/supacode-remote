package com.idachev.supacoderemote.sessions

import androidx.lifecycle.ViewModelStore
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.ClientMessage
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.TabNewReply
import com.idachev.supacoderemote.protocol.TabNewRequest
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NewTabViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  private class FakeLink : HostLink {
    override val messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    override val hostSession = MutableStateFlow<Int?>(1)
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
  private lateinit var notices: Notices
  private lateinit var vm: NewTabViewModel
  private val shown = mutableListOf<String>()
  private var refreshes = 0
  private val store = ViewModelStore()

  @Before
  fun setUp() {
    Dispatchers.setMain(dispatcher)
    link = FakeLink()
    notices = Notices()
    vm = NewTabViewModel(link, notices, refresh = { refreshes++ }, timeoutMs = 12_000)
    store.put("vm", vm)
  }

  @After
  fun tearDown() {
    store.clear()
    Dispatchers.resetMain()
  }

  /** Събира отворените табове и съобщенията към потребителя до края на теста. */
  private fun TestScope.collect(): List<TabNewReply> {
    val opened = mutableListOf<TabNewReply>()
    backgroundScope.launch { vm.opened.collect { opened += it } }
    backgroundScope.launch { notices.messages.collect { shown += it } }
    runCurrent()
    return opened
  }

  @Test
  fun `отговорът отваря таба с contentId и опреснява списъка`() = runTest(dispatcher) {
    val opened = collect()
    vm.create("w1")
    runCurrent()
    assertEquals(listOf<ClientMessage>(TabNewRequest(1, "w1")), link.sent)
    assertEquals("w1", vm.pendingWorktreeId.value)

    // Чужд отговор (друго id) не приключва чакането.
    link.messages.emit(TabNewReply(id = 99, worktreeId = "w1", tabId = "x", contentId = "x"))
    runCurrent()
    assertEquals("w1", vm.pendingWorktreeId.value)

    link.messages.emit(TabNewReply(id = 1, worktreeId = "w1", tabId = "t9", contentId = "c9"))
    runCurrent()
    assertEquals(listOf("c9"), opened.map { it.contentId })
    assertNull(vm.pendingWorktreeId.value)
    assertEquals(1, refreshes)
    assertTrue(shown.isEmpty())
  }

  @Test
  fun `грешка от Mac-а спира чакането и не отваря нищо`() = runTest(dispatcher) {
    val opened = collect()
    vm.create("w1")
    runCurrent()
    link.messages.emit(ErrorReply(1, "unknown worktree"))
    runCurrent()
    assertNull(vm.pendingWorktreeId.value)
    assertTrue(opened.isEmpty())
    assertEquals(0, refreshes)
    // Съобщението на Mac-а показва AppContainer за всеки `error`; тук не се удвоява.
    assertTrue(shown.isEmpty())
    // Таймаутът е отменен: след 12 s не идва второ съобщение.
    advanceTimeBy(13_000)
    runCurrent()
    assertTrue(shown.isEmpty())
  }

  @Test
  fun `без отговор за 12 s чакането спира със съобщение`() = runTest(dispatcher) {
    val opened = collect()
    vm.create("w1")
    runCurrent()
    advanceTimeBy(11_999)
    runCurrent()
    assertEquals("w1", vm.pendingWorktreeId.value)
    advanceTimeBy(2)
    runCurrent()
    assertNull(vm.pendingWorktreeId.value)
    assertEquals(listOf("Mac-ът не отвори таб навреме"), shown)

    // Закъснял отговор след таймаута не отваря терминал.
    link.messages.emit(TabNewReply(id = 1, worktreeId = "w1", tabId = "t9", contentId = "c9"))
    runCurrent()
    assertTrue(opened.isEmpty())
  }

  @Test
  fun `втори натиск докато чака не праща втора заявка`() = runTest(dispatcher) {
    collect()
    vm.create("w1")
    vm.create("w1")
    vm.create("w2")
    runCurrent()
    assertEquals(1, link.sent.size)
  }

  @Test
  fun `без онлайн Mac не се праща нищо`() = runTest(dispatcher) {
    collect()
    link.hostSession.value = null
    vm.create("w1")
    runCurrent()
    assertTrue(link.sent.isEmpty())
    assertNull(vm.pendingWorktreeId.value)
    assertEquals(listOf("Няма връзка с Mac-а"), shown)
  }
}
