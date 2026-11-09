package com.idachev.supacoderemote.ui.terminal

import androidx.compose.ui.graphics.vector.ImageVector
import com.idachev.supacoderemote.ui.pathIcon

/** Иконите на плаващите бутони върху терминала ([pathIcon]). */
object TerminalIcons {
  /** „arrow_back“: горната лента е скрита, бутонът горе вляво напуска терминала като „Назад“. */
  val ArrowBack: ImageVector = pathIcon("ArrowBack", "M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z")

  /** „keyboard_arrow_down“: горната лента е скрита, бутонът я сваля. */
  val ArrowDown: ImageVector = pathIcon("ArrowDown", "M7.41,8.59L12,13.17l4.59,-4.58L18,10l-6,6 -6,-6 1.41,-1.41z")

  /** „keyboard_arrow_up“: горната лента се вижда, бутонът я прибира. */
  val ArrowUp: ImageVector = pathIcon("ArrowUp", "M7.41,15.41L12,10.83l4.59,4.58L18,14l-6,-6 -6,6z")

  /** „vertical_align_bottom“: „Най-долу“ — най-новото в историята и в програмата. */
  val ToBottom: ImageVector = pathIcon("ToBottom", "M16,13h-3V3h-2v10H8l4,4 4,-4zM4,19v2h16v-2H4z")

  /** „keyboard“: полето за писане е прибрано, бутонът го разпъва. */
  val Keyboard: ImageVector = pathIcon(
    "Keyboard",
    "M20,5L4,5c-1.1,0 -1.99,0.9 -1.99,2L2,17c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2L22,7c0,-1.1 -0.9,-2 -2,-2z" +
      "M11,8h2v2h-2L11,8zM11,11h2v2h-2v-2zM8,8h2v2L8,10L8,8zM8,11h2v2L8,13v-2zM7,13L5,13v-2h2v2z" +
      "M7,10L5,10L5,8h2v2zM16,17L8,17v-2h8v2zM16,13h-2v-2h2v2zM16,10h-2L14,8h2v2zM19,13h-2v-2h2v2z" +
      "M19,10h-2L17,8h2v2z",
  )

  /** „keyboard_hide“: полето е разпънато, бутонът го прибира с клавиатурата. */
  val KeyboardHide: ImageVector = pathIcon(
    "KeyboardHide",
    "M20,3L4,3c-1.1,0 -1.99,0.9 -1.99,2L2,15c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2L22,5c0,-1.1 -0.9,-2 -2,-2z" +
      "M11,6h2v2h-2L11,6zM11,9h2v2h-2L11,9zM8,6h2v2L8,8L8,6zM8,9h2v2L8,11L8,9zM7,11L5,11L5,9h2v2z" +
      "M7,8L5,8L5,6h2v2zM16,15L8,15v-2h8v2zM16,11h-2L14,9h2v2zM16,8h-2L14,6h2v2zM19,11h-2L17,9h2v2z" +
      "M19,8h-2L17,6h2v2zM12,23l4,-4L8,19l4,4z",
  )
}
