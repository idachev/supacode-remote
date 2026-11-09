package com.idachev.supacoderemote.ui.sessions

import androidx.compose.ui.graphics.vector.ImageVector
import com.idachev.supacoderemote.ui.pathIcon

/** Иконите в „Сесии“: repository е етикет, worktree е ред, който се отваря. */
object SessionIcons {
  /** „folder“: заглавието на repository — само етикет, не се натиска. */
  val Repository: ImageVector = pathIcon(
    "Repository",
    "M10,4H4c-1.1,0 -1.99,0.9 -1.99,2L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V8c0,-1.1 -0.9,-2 -2,-2h-8l-2,-2z",
  )

  /** „account_tree“: worktree (branch) — редът отваря табовете му. */
  val Worktree: ImageVector = pathIcon(
    "Worktree",
    "M22,11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z",
  )

  /** „chevron_right“: редът води към друг екран. */
  val Open: ImageVector = pathIcon("Open", "M10,6L8.59,7.41 13.17,12l-4.58,4.59L10,18l6,-6z")
}
