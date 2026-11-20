package com.idachev.supacoderemote.terminal

/** Докъде е стигнал attach-ът на таба. Вход, `resize` и скрол към програмата вървят само в [Attached]. */
sealed interface AttachPhase {
  /** Чакаме връзка и онлайн Mac. */
  data object Waiting : AttachPhase

  data object Attaching : AttachPhase

  data class Attached(val cols: Int, val rows: Int) : AttachPhase

  data class Detached(val reason: String) : AttachPhase
}
