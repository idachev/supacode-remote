package com.idachev.supacoderemote.terminal

/**
 * Кога „Най-долу“ е стигнал дъното: подписът на екрана не се е сменял достатъчно дълго. До първата
 * промяна това е [TerminalViewModel.JUMP_FIRST_CHANGE_MS] (бавна връзка има време), после три пъти
 * колкото е отнела тя, между [TerminalViewModel.JUMP_QUIET_MIN_MS] и [TerminalViewModel.JUMP_QUIET_MAX_MS].
 */
internal class BottomDetector(private val startedAt: Long) {
  private var lastChangeAt = startedAt
  private var quietMs = TerminalViewModel.JUMP_FIRST_CHANGE_MS
  private var moved = false
  private var last: Int? = null

  /** Новият подпис [signature] в [now]; `true` — няма нови редове, програмата е на дъното. */
  fun atBottom(signature: Int, now: Long): Boolean {
    if (last != null && signature != last) {
      if (!moved) {
        moved = true
        quietMs = ((now - startedAt) * 3)
          .coerceIn(TerminalViewModel.JUMP_QUIET_MIN_MS, TerminalViewModel.JUMP_QUIET_MAX_MS)
      }
      lastChangeAt = now
    } else if (now - lastChangeAt >= quietMs) {
      return true
    }
    last = signature
    return false
  }
}
