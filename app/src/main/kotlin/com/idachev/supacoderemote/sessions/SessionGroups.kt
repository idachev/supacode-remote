package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.protocol.ListReply
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.SidebarSection
import com.idachev.supacoderemote.protocol.Worktree
import com.idachev.supacoderemote.protocol.WorktreeStatus

/** Групите на един repository по `status`: основен, закачени, активни (стар host без `sections`). */
data class RepositoryGroups(
  val repository: Repository,
  val main: List<Worktree>,
  val pinned: List<Worktree>,
  val active: List<Worktree>,
)

/** Един ред в списъка „Сесии“. */
sealed interface SessionRow {
  val key: String

  /** Глобалните секции „Active“ и „Pinned“ на sidebar-а, над групите. */
  data class SectionHeader(val id: String, val kind: String, val title: String) : SessionRow {
    override val key: String get() = "section:$id"
  }

  /**
   * Група от sidebar-а на Supacode, напр. „Work“. Сгъва се с докосване; [id] е
   * ключът за състоянието „сгъната“.
   */
  data class SidebarGroupHeader(val id: String, val name: String, val collapsed: Boolean = false) : SessionRow {
    override val key: String get() = "sidebar-group:$id"
  }

  data class RepositoryHeader(val repository: Repository) : SessionRow {
    override val key: String get() = "repo:${repository.id}"
  }

  /** „Закачени“ / „Активни“ под repository при стар host без `sections`. */
  data class GroupHeader(val repositoryId: String, val group: WorktreeStatus) : SessionRow {
    override val key: String get() = "group:$repositoryId:${group.wire}"
  }

  /**
   * Ред worktree. [repositoryName] е попълнено в секциите Active и Pinned, където редовете
   * са от различни repository-та и се показват като „repo · worktree“.
   */
  data class WorktreeRow(
    val repositoryId: String,
    val worktree: Worktree,
    val repositoryName: String? = null,
    val section: String = "",
  ) : SessionRow {
    override val key: String get() = "wt:$section:$repositoryId:${worktree.id}"
  }
}

object SessionGroups {

  /**
   * Подрежда по групи, без да пипа реда вътре в групата: host-ът вече праща реда на
   * sidebar-а, а тук само гарантираме main → pinned → активни, дори ако дойдат разбъркани.
   */
  fun of(repos: List<Repository>): List<RepositoryGroups> = repos.map { repo ->
    val byStatus = repo.worktrees.groupBy { WorktreeStatus.of(it.status) }
    RepositoryGroups(
      repository = repo,
      main = byStatus[WorktreeStatus.MAIN].orEmpty(),
      pinned = byStatus[WorktreeStatus.PINNED].orEmpty(),
      active = byStatus[WorktreeStatus.UNPINNED].orEmpty(),
    )
  }

  /**
   * Плоският списък за екрана. С `sections` е точно sidebar-ът на Supacode; без тях —
   * групиране по `status` във всеки repository. [collapsed] е изборът на телефона
   * по id на група; група без избор взима `collapsed` от Mac-а.
   */
  fun rows(list: ListReply, collapsed: Map<String, Boolean> = emptyMap()): List<SessionRow> =
    if (list.sections.isEmpty()) {
      rows(list.repos, collapsed)
    } else {
      sectionRows(list.repos, list.sections, collapsed)
    }

  private fun sectionRows(
    repos: List<Repository>,
    sections: List<SidebarSection>,
    collapsed: Map<String, Boolean>,
  ): List<SessionRow> {
    val repoById = repos.associateBy { it.id }
    val owner = repos.flatMap { r -> r.worktrees.map { it.id to r } }.toMap()
    return buildList {
      sections.forEachIndexed { index, section ->
        when (section.kind) {
          SidebarSection.ACTIVE, SidebarSection.PINNED -> {
            val id = "$index:${section.kind}"
            val rows = section.worktreeIds.mapNotNull { wtId ->
              val repo = owner[wtId] ?: return@mapNotNull null
              val wt = repo.worktrees.first { it.id == wtId }
              SessionRow.WorktreeRow(repo.id, wt, repositoryName = repo.name, section = id)
            }
            if (rows.isNotEmpty()) {
              val title = section.title?.ifBlank { null }
                ?: if (section.kind == SidebarSection.ACTIVE) "Active" else "Pinned"
              add(SessionRow.SectionHeader(id, section.kind, title))
              addAll(rows)
            }
          }
          SidebarSection.GROUP -> {
            val id = "$index:${section.title.orEmpty()}"
            val isCollapsed = collapsed[id] ?: section.collapsed
            add(SessionRow.SidebarGroupHeader(id, section.title?.ifBlank { null } ?: "Група", isCollapsed))
            if (!isCollapsed) {
              section.repositoryIds.mapNotNull(repoById::get).forEach { addRepository(it, "$index") }
            }
          }
          SidebarSection.REPOSITORY -> section.repositoryId?.let(repoById::get)?.let { addRepository(it, "$index") }
          else -> Unit
        }
      }
    }
  }

  /** Repository и редовете под него: `rowIds` по ред, а без тях — всичките му worktree-та. */
  private fun MutableList<SessionRow>.addRepository(repo: Repository, section: String) {
    add(SessionRow.RepositoryHeader(repo))
    val byId = repo.worktrees.associateBy { it.id }
    val worktrees = repo.rowIds?.mapNotNull(byId::get) ?: repo.worktrees
    worktrees.forEach { add(SessionRow.WorktreeRow(repo.id, it, section = section)) }
  }

  /**
   * Групите на sidebar-а по `group` (стар host без `sections`): първо repository-тата без
   * група, после всяка група по реда на първата ѝ поява. Вътре редът е както е дошъл.
   */
  fun bySidebarGroup(repos: List<Repository>): List<Pair<String?, List<Repository>>> {
    val ungrouped = repos.filter { it.sidebarGroup == null }
    val grouped = repos.filter { it.sidebarGroup != null }.groupBy { it.sidebarGroup!! }
    return buildList {
      if (ungrouped.isNotEmpty()) add(null to ungrouped)
      grouped.forEach { (name, list) -> add(name to list) }
    }
  }

  /**
   * Резервният списък без `sections`: групата на sidebar-а има заглавие; основният
   * worktree стои веднага под името на repository-то; „Закачени“ и „Активни“ имат
   * заглавие само ако не са празни.
   */
  fun rows(repos: List<Repository>, collapsed: Map<String, Boolean> = emptyMap()): List<SessionRow> =
    bySidebarGroup(repos).flatMap { (groupName, groupRepos) ->
      buildList {
        if (groupName != null) {
          val id = "group:$groupName"
          val isCollapsed = collapsed[id] ?: false
          add(SessionRow.SidebarGroupHeader(id, groupName, isCollapsed))
          if (isCollapsed) return@buildList
        }
        of(groupRepos).forEach { g ->
          val repoId = g.repository.id
          add(SessionRow.RepositoryHeader(g.repository))
          g.main.forEach { add(SessionRow.WorktreeRow(repoId, it)) }
          if (g.pinned.isNotEmpty()) {
            add(SessionRow.GroupHeader(repoId, WorktreeStatus.PINNED))
            g.pinned.forEach { add(SessionRow.WorktreeRow(repoId, it)) }
          }
          if (g.active.isNotEmpty()) {
            add(SessionRow.GroupHeader(repoId, WorktreeStatus.UNPINNED))
            g.active.forEach { add(SessionRow.WorktreeRow(repoId, it)) }
          }
        }
      }
    }

  /** Празно или само интервали име на група е „без група“. */
  private val Repository.sidebarGroup: String? get() = group?.trim()?.ifEmpty { null }

  fun findWorktree(repos: List<Repository>, repositoryId: String, worktreeId: String): Worktree? =
    repos.firstOrNull { it.id == repositoryId }?.worktrees?.firstOrNull { it.id == worktreeId }
}
