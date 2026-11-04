package com.idachev.supacoderemote.alerts

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.idachev.supacoderemote.MainActivity
import com.idachev.supacoderemote.R
import com.idachev.supacoderemote.SupacodeRemoteApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Държи връзката с relay-а и във фон, докато „Известия, когато агент чака“ е включено, и
 * пита за `list` на 15 s. Самите известия са в [AgentAlerts]; тук е само животът на
 * връзката. Връзката е същата като на екраните — [com.idachev.supacoderemote.relay.RelayClient].
 */
class AgentWatchService : Service() {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    AgentAlerts.createChannels(this)
    val tapIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(this, AgentAlerts.CHANNEL_WATCH)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Следя агентите на Mac-а")
      .setContentText("Известие, когато агент чака вход")
      .setOngoing(true)
      .setContentIntent(tapIntent)
      .build()
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    } else {
      0
    }
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)

    val container = (application as SupacodeRemoteApp).container
    // Рестарт от системата (START_STICKY) след изключен превключвател: нищо за правене.
    if (!container.settingsStore.notifyAwaiting.value) {
      stopSelf()
      return
    }
    container.relay.setKeepAlive(true)
    scope.launch {
      while (true) {
        // Пред очите на потребителя екраните питат на 3 s; тук е само за фона.
        if (!container.appInForeground.value) container.sessions.refresh()
        delay(POLL_MS)
      }
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  override fun onDestroy() {
    scope.cancel()
    (application as SupacodeRemoteApp).container.relay.setKeepAlive(false)
    super.onDestroy()
  }

  companion object {
    private const val NOTIFICATION_ID = 1
    const val POLL_MS = 15_000L

    /** Пуска или спира service-а според превключвателя. Вика се, докато приложението се вижда. */
    fun sync(context: Context, enabled: Boolean) {
      val intent = Intent(context, AgentWatchService::class.java)
      if (enabled) {
        ContextCompat.startForegroundService(context, intent)
      } else {
        context.stopService(intent)
      }
    }
  }
}
