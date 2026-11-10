package com.idachev.supacoderemote.sessions

import androidx.lifecycle.ViewModelStore
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.ClientMessage
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.WorktreeNewReply
import com.idachev.supacoderemote.protocol.WorktreeNewRequest
import com.idachev.supacoderemote.relay.HostLink
import com.idachev.supacoderemote.terminal.GridSize
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
class NewWorktreeViewModelTest {

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

  private val repo = Repository("r1", "supacode", canCreateWorktree = true)
  private lateinit var link: FakeLink
  private lateinit var notices: Notices
  private lateinit var vm: NewWorktreeViewModel
  private val shown = mutableListOf<String>()
  private val created = mutableListOf<WorktreeNewReply>()
  private var refreshes = 0
  private val store = ViewModelStore()

  @Before
  fun setUp() {
    Dispatchers.setMain(dispatcher)
    link = FakeLink()
    notices = Notices()
    vm = NewWorktreeViewModel(link, notices, refresh = { refreshes++ }, timeoutMs = 320_000, startGrid = { GridSize(90, 30) })
    store.put("vm", vm)
    vm.setVisible(true)
  }

  @After
  fun tearDown() {
    store.clear()
    Dispatchers.resetMain()
  }

  private fun TestScope.collect() {
    backgroundScope.launch {
      vm.created.collect { reply ->
        if (reply != null) {
          created += reply
          vm.consumeCreated()
        }
      }
    }
    backgroundScope.launch { notices.messages.collect { shown += it } }
    runCurrent()
  }

  private fun TestScope.startCreating(name: String = " feature-x "): WorktreeNewRequest {
    vm.open(repo)
    vm.setName(name)
    vm.create(existing = listOf("main"))
    runCurrent()
    return link.sent.last() as WorktreeNewRequest
  }

  @Test
  fun `успех праща името без интервали и размера и отваря първия таб`() = runTest(dispatcher) {
    collect()
    val request = startCreating()
    assertEquals(WorktreeNewRequest(1, "r1", "feature-x", 90, 30), request)
    assertTrue(vm.dialog.value!!.pending)
    link.messages.emit(WorktreeNewReply(1, "r1", "/w/feature-x", "feature-x", "t1", "c1"))
    runCurrent()
    assertNull(vm.dialog.value)
    assertEquals(listOf("c1"), created.map { it.contentId })
    assertEquals(1, refreshes)
  }

  @Test
  fun `име с подсказка не тръгва`() = runTest(dispatcher) {
    collect()
    vm.open(repo)
    vm.setName("Main")
    vm.create(existing = listOf("main"))
    vm.setName("")
    vm.create(existing = listOf("main"))
    assertTrue(link.sent.isEmpty())
  }

  @Test
  fun `отказ от Mac-а остава в диалога с името`() = runTest(dispatcher) {
    collect()
    startCreating()
    link.messages.emit(ErrorReply(1, "Branch name already exists: Choose another", code = "worktree_failed"))
    runCurrent()
    val d = vm.dialog.value!!
    assertEquals("Branch name already exists: Choose another", d.error)
    assertEquals(" feature-x ", d.name)
    assertTrue(!d.pending)
    assertTrue(shown.isEmpty())
  }

  @Test
  fun `worktree_timeout и таймаутът на телефона казват че не се знае как е свършило`() = runTest(dispatcher) {
    collect()
    startCreating()
    link.messages.emit(ErrorReply(1, "still running", code = ErrorReply.WORKTREE_TIMEOUT))
    runCurrent()
    assertEquals(NewWorktreeViewModel.UNKNOWN_OUTCOME, vm.dialog.value!!.error)

    vm.create(existing = emptyList())
    runCurrent()
    advanceTimeBy(320_001)
    runCurrent()
    assertEquals(NewWorktreeViewModel.UNKNOWN_OUTCOME, vm.dialog.value!!.error)
    assertTrue(!vm.dialog.value!!.pending)
  }

  @Test
  fun `нова сесия с host-а - отговорът няма да дойде и нов опит няма`() = runTest(dispatcher) {
    collect()
    startCreating()
    link.hostSession.value = null
    runCurrent()
    assertEquals(NewWorktreeViewModel.UNKNOWN_OUTCOME, vm.dialog.value!!.error)
    link.hostSession.value = 2
    runCurrent()
    assertEquals(1, link.sent.size)
    // Закъснял отговор от старата връзка не отваря нищо.
    link.messages.emit(WorktreeNewReply(1, "r1", "/w/feature-x", "feature-x", "t1", "c1"))
    runCurrent()
    assertTrue(created.isEmpty())
  }

  @Test
  fun `затворен диалог - Mac-ът продължава, успехът опреснява, отказът е в snackbar-а`() = runTest(dispatcher) {
    collect()
    startCreating()
    vm.dismiss()
    assertNull(vm.dialog.value)
    link.messages.emit(WorktreeNewReply(1, "r1", "/w/feature-x", "feature-x", "t1", "c1"))
    runCurrent()
    assertTrue(created.isEmpty())
    assertEquals(1, refreshes)
    assertEquals(listOf("Worktree-то „feature-x“ е създадено"), shown)

    startCreating("other")
    vm.dismiss()
    link.messages.emit(ErrorReply(2, "a worktree with this branch is already being created", code = "worktree_busy"))
    runCurrent()
    assertEquals("a worktree with this branch is already being created", shown.last())
  }

  @Test
  fun `затворен диалог и worktree_timeout - snackbar-ът е на български`() = runTest(dispatcher) {
    collect()
    startCreating()
    vm.dismiss()
    link.messages.emit(ErrorReply(1, "worktree creation is still running on the Mac", code = ErrorReply.WORKTREE_TIMEOUT))
    runCurrent()
    assertEquals(listOf(NewWorktreeViewModel.UNKNOWN_OUTCOME), shown)
  }

  @Test
  fun `закъснял успех след таймаута на телефона опреснява списъка`() = runTest(dispatcher) {
    collect()
    startCreating()
    advanceTimeBy(320_001)
    runCurrent()
    link.messages.emit(WorktreeNewReply(1, "r1", "/w/feature-x", "feature-x", "t1", "c1"))
    runCurrent()
    assertEquals(1, refreshes)
    assertTrue(created.isEmpty())
  }

  @Test
  fun `напуснати Сесии докато чака - успехът не прехвърля в терминала после`() = runTest(dispatcher) {
    collect()
    startCreating()
    vm.setVisible(false)
    assertNull(vm.dialog.value)
    link.messages.emit(WorktreeNewReply(1, "r1", "/w/feature-x", "feature-x", "t1", "c1"))
    runCurrent()
    vm.setVisible(true)
    runCurrent()
    assertTrue(created.isEmpty())
    assertEquals(1, refreshes)
  }

  @Test
  fun `без връзка заявката не тръгва и диалогът го казва`() = runTest(dispatcher) {
    collect()
    link.up = false
    startCreatingNoSend()
    assertEquals("Няма връзка — не е изпратено", vm.dialog.value!!.error)
    assertTrue(!vm.dialog.value!!.pending)
  }

  private fun TestScope.startCreatingNoSend() {
    vm.open(repo)
    vm.setName("x")
    vm.create(existing = emptyList())
    runCurrent()
  }
}
