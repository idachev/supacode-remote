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

  /** „refresh“: Mac-ът да прочете worktree-тата наново (ЗД13). */
  val Refresh: ImageVector = pathIcon(
    "Refresh",
    "M17.65,6.35C16.2,4.9 14.21,4 12,4c-4.42,0 -7.99,3.58 -7.99,8s3.57,8 7.99,8c3.73,0 6.84,-2.55 " +
      "7.73,-6h-2.08c-0.82,2.33 -3.04,4 -5.65,4 -3.31,0 -6,-2.69 -6,-6s2.69,-6 6,-6c1.66,0 3.14,0.69 " +
      "4.22,1.78L13,11h7V4l-2.35,2.35z",
  )

  /** „delete“: изтрий worktree-то (ЗД13). */
  val Delete: ImageVector = pathIcon(
    "Delete",
    "M6,19c0,1.1 0.9,2 2,2h8c1.1,0 2,-0.9 2,-2V7H6v12zM19,4h-3.5l-1,-1h-5l-1,1H5v2h14V4z",
  )

  /** „chevron_right“: редът води към друг екран. */
  val Open: ImageVector = pathIcon("Open", "M10,6L8.59,7.41 13.17,12l-4.58,4.59L10,18l6,-6z")
}
