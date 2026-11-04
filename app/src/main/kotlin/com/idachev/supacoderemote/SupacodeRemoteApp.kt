package com.idachev.supacoderemote

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

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
        container.relay.setForeground(true)
      }

      override fun onStop(owner: LifecycleOwner) {
        container.appInForeground.value = false
        container.relay.setForeground(false)
      }
    })
  }
}
