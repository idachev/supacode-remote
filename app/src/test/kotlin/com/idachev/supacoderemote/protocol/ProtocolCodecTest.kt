package com.idachev.supacoderemote.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Примерите са от docs/remote-access-protocol.md в repo-то на Supacode, дума по дума. */
class ProtocolCodecTest {

  private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

  private fun assertSameJson(expected: String, actual: String) = assertEquals(json(expected), json(actual))

  @Test
  fun `relay съобщението казва дали Mac-ът е онлайн`() {
    assertEquals(RelayStatus(true), ProtocolCodec.decode("""{"t":"relay","hostOnline":true}"""))
    assertEquals(RelayStatus(false), ProtocolCodec.decode("""{"t":"relay","hostOnline":false}"""))
  }

  @Test
  fun `hello от host-а носи името на Mac-а`() {
    assertEquals(HelloReply(1, "Mac mini"), ProtocolCodec.decode("""{"t":"hello","v":1,"host":"Mac mini"}"""))
  }

  @Test
  fun `list от примера се чете цял`() {
    // Примерът от документа, с буквалните „main|pinned|unpinned“ и „busy|awaitingInput|…“.
    val text = """
      {"t":"list","id":1,"repos":[
        {"id":"<repository id>","name":"supacode","group":"<sidebar group name, omitted when none>","worktrees":[
          {"id":"<worktree id>","name":"remote-access","branch":"remote-access",
           "status":"main|pinned|unpinned","focused":true,"title":"<custom title or null>",
           "working":true,"tabs":[
             {"id":"<tab uuid>","contentId":"<content uuid>","title":"claude","focused":true,
              "working":false,"readOnly":false,
              "agents":[{"agent":"claude","activity":"busy|awaitingInput|idle|error|compacting"}]}
           ]}
        ]}
      ]}
    """.trimIndent()
    val reply = ProtocolCodec.decode(text) as ListReply
    assertEquals(1, reply.id)
    val repo = reply.repos.single()
    assertEquals("supacode", repo.name)
    assertEquals("<sidebar group name, omitted when none>", repo.group)
    val wt = repo.worktrees.single()
    assertEquals("remote-access", wt.name)
    assertEquals("remote-access", wt.branch)
    assertTrue(wt.focused)
    assertTrue(wt.working)
    assertEquals("<custom title or null>", wt.displayName)
    // Непознат статус не чупи четенето и отива при активните.
    assertEquals(WorktreeStatus.UNPINNED, WorktreeStatus.of(wt.status))
    val tab = wt.tabs.single()
    assertEquals("<content uuid>", tab.contentId)
    assertEquals("claude", tab.title)
    assertEquals(false, tab.readOnly)
    assertEquals(AgentBadge("claude", "busy|awaitingInput|idle|error|compacting"), tab.agents.single())
    assertEquals(AgentActivity.UNKNOWN, AgentActivity.of(tab.agents.single().activity))
  }

  @Test
  fun `list без group и title — изпуснатите полета са null`() {
    val text = """{"t":"list","id":8,"repos":[{"id":"r","name":"n","worktrees":[
      {"id":"w","name":"feature","branch":"feature","status":"unpinned","focused":false,"working":false,"tabs":[]}]}]}"""
    val repo = (ProtocolCodec.decode(text) as ListReply).repos.single()
    assertNull(repo.group)
    assertNull(repo.worktrees.single().title)
    assertEquals("feature", repo.worktrees.single().displayName)
  }

  @Test
  fun `list с истински стойности и активностите от протокола`() {
    listOf(
      "busy" to AgentActivity.BUSY,
      "awaitingInput" to AgentActivity.AWAITING_INPUT,
      "idle" to AgentActivity.IDLE,
      "error" to AgentActivity.ERROR,
      "compacting" to AgentActivity.COMPACTING,
    ).forEach { (wire, activity) -> assertEquals(activity, AgentActivity.of(wire)) }
  }

  @Test
  fun `list с истински стойности и title null`() {
    val text = """{"t":"list","id":7,"repos":[{"id":"r","name":"n","worktrees":[
      {"id":"w","name":"main","branch":"main","status":"pinned","focused":false,"title":null,"working":false,
       "tabs":[{"id":"t","contentId":"c","title":"zsh","focused":false,"working":true,"readOnly":true,
                "agents":[{"agent":"codex","activity":"awaitingInput"}]}]}]}]}"""
    val wt = (ProtocolCodec.decode(text) as ListReply).repos.single().worktrees.single()
    assertNull(wt.title)
    assertEquals("main", wt.displayName)
    assertEquals(WorktreeStatus.PINNED, WorktreeStatus.of(wt.status))
    assertEquals(AgentActivity.AWAITING_INPUT, AgentActivity.of(wt.tabs.single().agents.single().activity))
    assertTrue(wt.tabs.single().readOnly)
  }

  @Test
  fun `sections и rowIds от примера се четат, а непознатите полета не пречат`() {
    val text = """{"t":"list","id":1,"repos":[
      {"id":"r1","name":"supacode","rowIds":["w1"],"worktrees":[{"id":"w1","name":"main","status":"main","tabs":[]}]}],
      "sections":[
        {"kind":"active","title":"Active","worktreeIds":["<worktree id>", "…"]},
        {"kind":"pinned","title":"Pinned","worktreeIds":["…"]},
        {"kind":"group","title":"Work","collapsed":true,"repositoryIds":["<repository id>"]},
        {"kind":"repository","repositoryId":"<repository id>","extra":1}
      ]}"""
    val reply = ProtocolCodec.decode(text) as ListReply
    assertEquals(listOf("w1"), reply.repos.single().rowIds)
    assertEquals(
      listOf(
        SidebarSection(kind = "active", title = "Active", worktreeIds = listOf("<worktree id>", "…")),
        SidebarSection(kind = "pinned", title = "Pinned", worktreeIds = listOf("…")),
        SidebarSection(kind = "group", title = "Work", collapsed = true, repositoryIds = listOf("<repository id>")),
        SidebarSection(kind = "repository", repositoryId = "<repository id>"),
      ),
      reply.sections,
    )
  }

  @Test
  fun `list без sections и rowIds — стар host`() {
    val reply = ProtocolCodec.decode("""{"t":"list","id":2,"repos":[{"id":"r","name":"n"}]}""") as ListReply
    assertEquals(emptyList<SidebarSection>(), reply.sections)
    assertNull(reply.repos.single().rowIds)
  }

  @Test
  fun `attached out size detached`() {
    assertEquals(Attached(2, "c1", 180, 50), ProtocolCodec.decode("""{"t":"attached","id":2,"contentId":"c1","cols":180,"rows":50}"""))
    assertEquals(Output("c1", "aGk="), ProtocolCodec.decode("""{"t":"out","contentId":"c1","b64":"aGk="}"""))
    assertEquals(SizeChanged("c1", 120, 40), ProtocolCodec.decode("""{"t":"size","contentId":"c1","cols":120,"rows":40}"""))
    assertEquals(Detached("c1", "session ended"), ProtocolCodec.decode("""{"t":"detached","contentId":"c1","reason":"session ended"}"""))
  }

  @Test
  fun `suggest отговорът е списък от низове`() {
    assertEquals(
      Suggestions(3, "c1", listOf("git status", "/btw")),
      ProtocolCodec.decode("""{"t":"suggest","id":3,"contentId":"c1","suggestions":["git status","/btw"]}"""),
    )
  }

  @Test
  fun `error с id и без id`() {
    assertEquals(ErrorReply(4, "boom"), ProtocolCodec.decode("""{"t":"error","id":4,"message":"boom"}"""))
    assertEquals(ErrorReply(null, "host offline"), ProtocolCodec.decode("""{"t":"error","id":null,"message":"host offline"}"""))
    assertEquals(ErrorReply(null, "host offline"), ProtocolCodec.decode("""{"t":"error","message":"host offline"}"""))
  }

  @Test
  fun `pong непознат тип и счупен JSON се пропускат`() {
    assertNull(ProtocolCodec.decode("pong"))
    assertNull(ProtocolCodec.decode("""{"t":"conn.open"}"""))
    assertNull(ProtocolCodec.decode("""{"t":"attached","contentId":"c"}"""))
    assertNull(ProtocolCodec.decode("{not json"))
    assertNull(ProtocolCodec.decode("[1,2]"))
  }

  @Test
  fun `излизащите съобщения са точно като в протокола`() {
    assertSameJson("""{"t":"hello","v":1}""", ProtocolCodec.encode(HelloRequest()))
    assertSameJson("""{"t":"list","id":1}""", ProtocolCodec.encode(ListRequest(1)))
    assertSameJson(
      """{"t":"attach","id":2,"contentId":"c","scrollback":500}""",
      ProtocolCodec.encode(AttachRequest(id = 2, contentId = "c")),
    )
    assertSameJson("""{"t":"detach","contentId":"c"}""", ProtocolCodec.encode(DetachRequest("c")))
    assertSameJson("""{"t":"input","contentId":"c","b64":"DQ=="}""", ProtocolCodec.encode(InputRequest("c", "DQ==")))
    assertSameJson("""{"t":"suggest","id":3,"contentId":"c"}""", ProtocolCodec.encode(SuggestRequest(3, "c")))
  }

  @Test
  fun `tab new заявката е точно като в протокола`() {
    assertSameJson("""{"t":"tab.new","id":4,"worktreeId":"w1"}""", ProtocolCodec.encode(TabNewRequest(4, "w1")))
  }

  @Test
  fun `tab new отговорът носи tabId и contentId`() {
    assertEquals(
      TabNewReply(id = 4, worktreeId = "w1", tabId = "t9", contentId = "c9"),
      ProtocolCodec.decode("""{"t":"tab.new","id":4,"worktreeId":"w1","tabId":"t9","contentId":"c9"}"""),
    )
    // Грешката за tab.new е обикновен `error` със същото id.
    assertEquals(
      ErrorReply(4, "unknown worktree"),
      ProtocolCodec.decode("""{"t":"error","id":4,"message":"unknown worktree"}"""),
    )
    // Без contentId отговорът е безполезен — пропуска се, вместо да отвори празен терминал.
    assertNull(ProtocolCodec.decode("""{"t":"tab.new","id":4,"worktreeId":"w1","tabId":"t9"}"""))
  }

  @Test
  fun `relay от нов relay носи свързания Mac и списъка с Mac-ове`() {
    val text = """{"t":"relay","hostOnline":true,"host":"3f9a0c1d2e4b5a69",
      "hosts":[{"id":"3f9a0c1d2e4b5a69","name":"Office Mac","online":true},{"id":"default","online":false}]}"""
    assertEquals(
      RelayStatus(
        hostOnline = true,
        host = "3f9a0c1d2e4b5a69",
        hosts = listOf(HostInfo("3f9a0c1d2e4b5a69", "Office Mac", true), HostInfo("default", null, false)),
      ),
      ProtocolCodec.decode(text),
    )
  }

  @Test
  fun `relay без hosts е стар relay, а празен списък е нов relay без Mac-ове`() {
    val old = ProtocolCodec.decode("""{"t":"relay","hostOnline":true}""") as RelayStatus
    assertNull(old.hosts)
    assertNull(old.host)
    val empty = ProtocolCodec.decode("""{"t":"relay","hostOnline":false,"hosts":[]}""") as RelayStatus
    assertEquals(emptyList<HostInfo>(), empty.hosts)
    assertNull(empty.host)
  }

  @Test
  fun `Mac в списъка без name и без online е без име и извън линия`() {
    val status = ProtocolCodec.decode("""{"t":"relay","hostOnline":false,"hosts":[{"id":"default"}]}""") as RelayStatus
    assertEquals(listOf(HostInfo("default", null, false)), status.hosts)
  }

  @Test
  fun `hello носи hostId на Mac-а, а без него е null`() {
    assertEquals(
      HelloReply(1, "Office Mac", hostId = "3f9a0c1d2e4b5a69"),
      ProtocolCodec.decode("""{"t":"hello","v":1,"host":"Office Mac","hostId":"3f9a0c1d2e4b5a69"}"""),
    )
    assertNull((ProtocolCodec.decode("""{"t":"hello","v":1,"host":"Mac"}""") as HelloReply).hostId)
  }
}
