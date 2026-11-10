package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.ClientMessage
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.ListReply
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.WorktreeDeleteReply
import com.idachev.supacoderemote.protocol.WorktreeDeleteRequest
import com.idachev.supacoderemote.protocol.WorktreesRefreshRequest
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorktreeActionsTest {

  private class FakeLink : HostLink {
    override val messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    override val hostSession = MutableStateFlow<Int?>(1)
    val sent = mutableListOf<ClientMessage>()
    private var id = 0

    override fun send(message: ClientMessage): Boolean {
      sent += message
      return true
    }

    override fun nextId(): Int = ++id
  }

  private val link = FakeLink()
  private val notices = Notices()
  private val shown = mutableListOf<String>()
  private val deleted = mutableListOf<String>()
  private var refreshes = 0

  private fun TestScope.actions(): WorktreeActions {
    val actions = WorktreeActions(link, notices, refreshList = { refreshes++ }, scope = backgroundScope)
    backgroundScope.launch { notices.messages.collect { shown += it } }
    backgroundScope.launch { actions.deleted.collect { deleted += it } }
    runCurrent()
    return actions
  }

  @Test
  fun `изтриване - заявката, Изтривам и после списъкът и затварянето на екраните`() = runTest {
    val a = actions()
    a.delete("/w/x", "x")
    runCurrent()
    assertEquals(WorktreeDeleteRequest(1, "/w/x"), link.sent.single())
    assertEquals(setOf("/w/x"), a.deleting.value)
    link.messages.emit(WorktreeDeleteReply(1, "/w/x", "r1"))
    runCurrent()
    assertTrue(a.deleting.value.isEmpty())
    assertEquals(listOf("Изтрих „x“"), shown)
    assertEquals(1, refreshes)
    assertEquals(listOf("/w/x"), deleted)
  }

  @Test
  fun `worktree_dirty - редът остава и съобщението изброява файловете`() = runTest {
    val a = actions()
    a.delete("/w/x", "x")
    runCurrent()
    link.messages.emit(ErrorReply(1, "the worktree has uncommitted changes (1): a.txt", code = ErrorReply.WORKTREE_DIRTY))
    runCurrent()
    assertTrue(a.deleting.value.isEmpty())
    assertEquals(listOf("Не изтрих „x“: the worktree has uncommitted changes (1): a.txt"), shown)
    assertTrue(deleted.isEmpty())
  }

  @Test
  fun `worktree_timeout, таймаут и нова сесия казват че изходът не е известен`() = runTest {
    val a = actions()
    a.delete("/w/a", "a")
    runCurrent()
    link.messages.emit(ErrorReply(1, "still running", code = ErrorReply.WORKTREE_TIMEOUT))
    runCurrent()
    a.delete("/w/b", "b")
    runCurrent()
    advanceTimeBy(WorktreeActions.DELETE_TIMEOUT_MS + 1)
    runCurrent()
    a.delete("/w/c", "c")
    runCurrent()
    link.hostSession.value = 2
    runCurrent()
    assertEquals(List(3) { WorktreeActions.DELETE_UNKNOWN }, shown)
    assertTrue(a.deleting.value.isEmpty())
    assertEquals(3, link.sent.size)
  }

  @Test
  fun `второ натискане докато чака не праща нищо`() = runTest {
    val a = actions()
    a.delete("/w/x", "x")
    a.delete("/w/x", "x")
    runCurrent()
    assertEquals(1, link.sent.size)
  }

  @Test
  fun `опресняване - list със същото id го приключва, refresh_timeout се казва на български`() = runTest {
    val a = actions()
    assertTrue(a.refresh())
    runCurrent()
    assertEquals(WorktreesRefreshRequest(1), link.sent.single())
    assertTrue(a.refreshing.value)
    // Обикновен list (без id или с друго) не е отговорът.
    link.messages.emit(ListReply(id = null))
    runCurrent()
    assertTrue(a.refreshing.value)
    link.messages.emit(ListReply(id = 1, canRefreshWorktrees = true))
    runCurrent()
    assertFalse(a.refreshing.value)

    a.refresh()
    runCurrent()
    link.messages.emit(ErrorReply(2, "the refresh is still running", code = ErrorReply.REFRESH_TIMEOUT))
    runCurrent()
    assertFalse(a.refreshing.value)
    assertEquals(listOf(WorktreeActions.REFRESH_LATER), shown)
  }

  @Test
  fun `опресняване без връзка не тръгва`() = runTest {
    val a = actions()
    link.hostSession.value = null
    runCurrent()
    assertFalse(a.refresh())
    assertTrue(link.sent.isEmpty())
  }
}
