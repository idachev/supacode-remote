package com.idachev.supacoderemote

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.idachev.supacoderemote.terminal.TerminalPool

class SupacodeRemoteApp : Application() {

  lateinit var container: AppContainer
    private set

  override fun onCreate() {
    super.onCreate()
    container = AppContainer(this)
    // Връзката е докато приложението се вижда, а във фон — само ако AgentWatchService я държи
    // за известията. ProcessLifecycleOwner изчаква малко след onStop, затова завъртането не
    // я къса.
    ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
      override fun onStart(owner: LifecycleOwner) {
        container.appInForeground.value = true
        container.terminalPool.foregrounded()
        container.relay.setForeground(true)
      }

      override fun onStop(owner: LifecycleOwner) {
        container.appInForeground.value = false
        // Преди връзката: detach на скритите табове тръгва, докато тя още е горе (ДЗ20).
        container.terminalPool.backgrounded()
        container.relay.setForeground(false)
      }
    })
  }

  /** Недостиг на памет: живите терминали се свиват до видимия (ДЗ20). */
  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    if (TerminalPool.shrinksOnTrim(level)) container.terminalPool.shrinkToVisible()
  }
}
