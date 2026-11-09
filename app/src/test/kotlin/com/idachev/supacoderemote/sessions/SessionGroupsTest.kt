package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.protocol.ListReply
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.SidebarSection
import com.idachev.supacoderemote.protocol.Worktree
import com.idachev.supacoderemote.protocol.WorktreeStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionGroupsTest {

  private fun wt(id: String, status: String) = Worktree(id = id, name = id, status = status)

  private val repos = listOf(
    Repository(
      id = "r1",
      name = "supacode",
      worktrees = listOf(
        // Разбъркани нарочно: групите трябва да излязат main → pinned → активни.
        wt("a1", "unpinned"),
        wt("p1", "pinned"),
        wt("m", "main"),
        wt("a2", "unpinned"),
        wt("p2", "pinned"),
        wt("x", "archived?"),
      ),
    ),
    Repository(id = "r2", name = "notes-app", worktrees = listOf(wt("m2", "main"))),
  )

  @Test
  fun `групите пазят реда от host-а вътре в групата`() {
    val g = SessionGroups.of(repos).first()
    assertEquals(listOf("m"), g.main.map { it.id })
    assertEquals(listOf("p1", "p2"), g.pinned.map { it.id })
    // Непознатият статус е при активните, на мястото си.
    assertEquals(listOf("a1", "a2", "x"), g.active.map { it.id })
  }

  @Test
  fun `редовете са repository, main, Закачени, Активни`() {
    val rows = SessionGroups.rows(repos).map {
      when (it) {
        is SessionRow.SectionHeader -> "section ${it.title}"
        is SessionRow.SidebarGroupHeader -> "sidebar ${it.name}"
        is SessionRow.RepositoryHeader -> "repo ${it.repository.name}"
        is SessionRow.GroupHeader -> "group ${it.group.wire}"
        is SessionRow.WorktreeRow -> "wt ${it.worktree.id}"
      }
    }
    assertEquals(
      listOf(
        "repo supacode", "wt m",
        "group pinned", "wt p1", "wt p2",
        "group unpinned", "wt a1", "wt a2", "wt x",
        "repo notes-app", "wt m2",
      ),
      rows,
    )
  }

  @Test
  fun `групите на sidebar-а идват след repository-тата без група и пазят реда`() {
    val list = listOf(
      Repository(id = "g1", name = "shop-a", group = "Work", worktrees = listOf(wt("ga", "main"))),
      Repository(id = "u1", name = "solo", worktrees = listOf(wt("u", "main"))),
      Repository(id = "g2", name = "archive", group = "Digital Archives", worktrees = listOf(wt("gb", "main"))),
      Repository(id = "g3", name = "shop-b", group = "Work", worktrees = listOf(wt("gc", "main"))),
      Repository(id = "u2", name = "blank", group = "  ", worktrees = listOf(wt("u2m", "main"))),
    )
    val rows = SessionGroups.rows(list).mapNotNull {
      when (it) {
        is SessionRow.SidebarGroupHeader -> "sidebar ${it.name}"
        is SessionRow.RepositoryHeader -> "repo ${it.repository.name}"
        else -> null
      }
    }
    assertEquals(
      listOf(
        "repo solo", "repo blank",
        "sidebar Work", "repo shop-a", "repo shop-b",
        "sidebar Digital Archives", "repo archive",
      ),
      rows,
    )
  }

  @Test
  fun `празна група няма заглавие и ключовете са уникални`() {
    val rows = SessionGroups.rows(repos)
    assertEquals(rows.size, rows.map { it.key }.toSet().size)
    val second = SessionGroups.rows(listOf(repos[1]))
    assertEquals(0, second.count { it is SessionRow.GroupHeader })
  }

  private fun describe(rows: List<SessionRow>) = rows.map {
    when (it) {
      is SessionRow.SectionHeader -> "section ${it.title}"
      is SessionRow.SidebarGroupHeader -> "sidebar ${it.name}${if (it.collapsed) " (сгъната)" else ""}"
      is SessionRow.RepositoryHeader -> "repo ${it.repository.name}"
      is SessionRow.GroupHeader -> "group ${it.group.wire}"
      is SessionRow.WorktreeRow -> "wt ${it.repositoryName?.let { n -> "$n · " }.orEmpty()}${it.worktree.id}"
    }
  }

  private val sidebarList = ListReply(
    repos = listOf(
      Repository(id = "sup", name = "supacode", rowIds = listOf("m", "a2"),
        worktrees = listOf(wt("m", "main"), wt("run", "unpinned"), wt("a2", "unpinned"))),
      Repository(id = "plx", name = "shop", group = "Work", rowIds = listOf("pm"),
        worktrees = listOf(wt("pm", "main"), wt("pp", "pinned"))),
      Repository(id = "notes", name = "notes", group = "Personal", rowIds = listOf("mm"),
        worktrees = listOf(wt("mm", "main"))),
    ),
    sections = listOf(
      SidebarSection(kind = "active", title = "Active", worktreeIds = listOf("run", "missing")),
      SidebarSection(kind = "pinned", title = "Pinned", worktreeIds = listOf("pp")),
      SidebarSection(kind = "group", title = "Work", collapsed = true, repositoryIds = listOf("plx")),
      SidebarSection(kind = "group", title = "Personal", repositoryIds = listOf("notes")),
      SidebarSection(kind = "future-kind"),
      SidebarSection(kind = "repository", repositoryId = "sup"),
    ),
  )

  @Test
  fun `със sections списъкът е точно sidebar-ът — Active, Pinned, групи, repository-та`() {
    assertEquals(
      listOf(
        "section Active", "wt supacode · run",
        "section Pinned", "wt shop · pp",
        "sidebar Work (сгъната)",
        "sidebar Personal", "repo notes", "wt mm",
        "repo supacode", "wt m", "wt a2",
      ),
      describe(SessionGroups.rows(sidebarList)),
    )
  }

  @Test
  fun `групата се разгъва и сгъва от телефона, а не само от Mac-а`() {
    val rows = SessionGroups.rows(sidebarList)
    val work = rows.filterIsInstance<SessionRow.SidebarGroupHeader>().first { it.name == "Work" }
    val personal = rows.filterIsInstance<SessionRow.SidebarGroupHeader>().first { it.name == "Personal" }
    val toggled = describe(SessionGroups.rows(sidebarList, mapOf(work.id to false, personal.id to true)))
    assertEquals(
      listOf(
        "section Active", "wt supacode · run",
        "section Pinned", "wt shop · pp",
        "sidebar Work", "repo shop", "wt pm",
        "sidebar Personal (сгъната)",
        "repo supacode", "wt m", "wt a2",
      ),
      toggled,
    )
    assertEquals(rows.size, rows.map { it.key }.toSet().size)
  }

  @Test
  fun `празни sections значат стария формат, а празна Active секция няма заглавие`() {
    assertEquals(describe(SessionGroups.rows(repos)), describe(SessionGroups.rows(ListReply(repos = repos))))
    val noActive = sidebarList.copy(sections = listOf(SidebarSection(kind = "active", worktreeIds = listOf("missing"))))
    assertEquals(emptyList<String>(), describe(SessionGroups.rows(noActive)))
  }

  @Test
  fun `repository без rowIds показва всичките си worktree-та`() {
    val list = ListReply(
      repos = listOf(Repository(id = "r", name = "r", worktrees = listOf(wt("x", "main"), wt("y", "unpinned")))),
      sections = listOf(SidebarSection(kind = "repository", repositoryId = "r")),
    )
    assertEquals(listOf("repo r", "wt x", "wt y"), describe(SessionGroups.rows(list)))
  }

  @Test
  fun `търсенето по име на worktree отваря сгънатата група и скрива останалото`() {
    // „pm“ е в сгънатата група Work: при търсене тя се разгъва, без да пипа избора на телефона.
    assertEquals(
      listOf("sidebar Work", "repo shop", "wt pm"),
      describe(SessionGroups.rows(sidebarList, query = "PM")),
    )
    // „pp“ е само в Pinned (няма го в rowIds): repository-то и групата му не остават празни заглавия.
    assertEquals(listOf("section Pinned", "wt shop · pp"), describe(SessionGroups.rows(sidebarList, query = "pp")))
    assertEquals(
      listOf("section Pinned", "wt shop · pp", "sidebar Work", "repo shop", "wt pp"),
      describe(SessionGroups.rows(sidebarList.copy(repos = sidebarList.repos.map { r ->
        if (r.id == "plx") r.copy(rowIds = listOf("pm", "pp")) else r
      }), query = " pp ")),
    )
  }

  @Test
  fun `търсенето по име на repository показва всичките му worktree-та`() {
    assertEquals(
      listOf("section Active", "wt supacode · run", "repo supacode", "wt m", "wt a2"),
      describe(SessionGroups.rows(sidebarList, query = "supa")),
    )
    // И сгъната от телефона група се отваря, щом в нея има намерено.
    val work = SessionGroups.rows(sidebarList).filterIsInstance<SessionRow.SidebarGroupHeader>().first()
    assertEquals(
      listOf("section Pinned", "wt shop · pp", "sidebar Work", "repo shop", "wt pm"),
      describe(SessionGroups.rows(sidebarList, mapOf(work.id to true), query = "shop")),
    )
  }

  @Test
  fun `търсенето гледа и заглавието и branch-а на worktree-то`() {
    val list = ListReply(
      repos = listOf(
        Repository(id = "r", name = "r", worktrees = listOf(
          Worktree(id = "x", name = "x", status = "main", title = "Поправка на входа"),
          Worktree(id = "y", name = "y", status = "unpinned", branch = "feature/search"),
          wt("z", "unpinned"),
        )),
      ),
      sections = listOf(SidebarSection(kind = "repository", repositoryId = "r")),
    )
    assertEquals(listOf("repo r", "wt x"), describe(SessionGroups.rows(list, query = "поправка")))
    assertEquals(listOf("repo r", "wt y"), describe(SessionGroups.rows(list, query = "search")))
    assertEquals(emptyList<String>(), describe(SessionGroups.rows(list, query = "няма такова")))
  }

  @Test
  fun `търсенето работи и в стария формат без sections`() {
    val grouped = repos + Repository(id = "g", name = "work-repo", group = "Work", worktrees = listOf(wt("gm", "main")))
    val work = SessionGroups.rows(grouped).filterIsInstance<SessionRow.SidebarGroupHeader>().first()
    assertEquals(
      listOf("repo supacode", "group pinned", "wt p2", "group unpinned", "wt a2", "repo notes-app", "wt m2"),
      describe(SessionGroups.rows(grouped, query = "2")),
    )
    assertEquals(
      listOf("sidebar Work", "repo work-repo", "wt gm"),
      describe(SessionGroups.rows(grouped, mapOf(work.id to true), query = "work")),
    )
    // Празно търсене е без филтър.
    assertEquals(describe(SessionGroups.rows(grouped)), describe(SessionGroups.rows(grouped, query = "  ")))
  }

  @Test
  fun `worktree се намира по repository и id`() {
    assertEquals("p2", SessionGroups.findWorktree(repos, "r1", "p2")?.id)
    assertNull(SessionGroups.findWorktree(repos, "r2", "p2"))
    assertEquals(WorktreeStatus.MAIN, WorktreeStatus.of(SessionGroups.findWorktree(repos, "r2", "m2")!!.status))
  }
}
