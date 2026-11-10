package com.idachev.supacoderemote.alerts

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.idachev.supacoderemote.MainActivity
import com.idachev.supacoderemote.R
import com.idachev.supacoderemote.protocol.Repository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.launch

/**
 * Известията „агент чака“. Гледа всеки нов `list`, докато превключвателят в „Настройка“
 * е включен. Известие се пуска само когато приложението не се вижда — пред очите на потребителя
 * значката в списъка стига; но и тогава преходът се запомня, за да не дойде известие
 * по-късно за нещо, което той вече е видял.
 *
 * Известия има само от свързания Mac ([boundHostId], решение ОП9): връзката носи само него.
 * При смяна известията на стария се махат. Id-то на известието съдържа и Mac-а, защото
 * `contentId` е уникален само в един Mac.
 */
class AgentAlerts(
  private val context: Context,
  private val repos: StateFlow<List<Repository>?>,
  private val boundHostId: StateFlow<String?>,
  private val appInForeground: StateFlow<Boolean>,
  private val scope: CoroutineScope,
) {

  private var job: Job? = null

  init {
    // При смяна на Mac-а се махат всички известия „агент чака“, и тези, които tracker-ът не
    // помни: пуснати преди изключване на известията или преди рестарт на процеса.
    scope.launch {
      var last = boundHostId.value
      boundHostId.collect { current ->
        if (current == last) return@collect
        last = current
        cancelAllAwaiting()
      }
    }
  }

  private fun cancelAllAwaiting() {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    manager.activeNotifications.filter { it.tag == TAG }.forEach { manager.cancel(TAG, it.id) }
  }

  fun setEnabled(enabled: Boolean) {
    job?.cancel()
    job = null
    if (!enabled) return
    createChannels(context)
    // Нов tracker при всяко включване: чакащите в този момент дават известие, ако сме във фон.
    val watch = HostWatch(AwaitingTracker(), boundHostId.value)
    job = scope.launch {
      // Един събирач за двете, за да не се засичат списък и смяна на Mac-а в tracker-а.
      merge(
        repos.filterNotNull().map { AlertEvent.List(it) },
        boundHostId.map { AlertEvent.HostChanged },
      ).collect { watch.onEvent(it) }
    }
  }

  /** Известията на свързания Mac: кой е той ([hostId]) и кои табове вече чакат ([tracker]). */
  private inner class HostWatch(private val tracker: AwaitingTracker, private var hostId: String?) {

    fun onEvent(event: AlertEvent) {
      followBoundHost()
      if (event is AlertEvent.List) onList(event.repos)
    }

    /**
     * Смяната се познава по текущия Mac при всяко събитие: списъкът на новия Mac може да дойде
     * преди самото събитие за смяната.
     */
    private fun followBoundHost() {
      val current = boundHostId.value
      if (current == hostId) return
      tracker.reset().forEach { cancel(hostId, it) }
      hostId = current
    }

    private fun onList(repos: List<Repository>) {
      val changes = tracker.update(repos)
      changes.ended.forEach { cancel(hostId, it) }
      if (!appInForeground.value) changes.started.forEach { post(hostId, it) }
    }
  }

  private sealed interface AlertEvent {
    data class List(val repos: kotlin.collections.List<Repository>) : AlertEvent

    data object HostChanged : AlertEvent
  }

  private fun post(hostId: String?, tab: AwaitingTab) {
    if (!canPost(context)) return
    val notification = NotificationCompat.Builder(context, CHANNEL_AWAITING)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("${tab.worktreeName} · ${tab.tabTitle}")
      .setContentText("${tab.agent} чака вход")
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(openTerminalIntent(hostId, tab))
      .build()
    NotificationManagerCompat.from(context).notify(TAG, notificationId(hostId, tab.contentId), notification)
  }

  private fun cancel(hostId: String?, contentId: String) {
    NotificationManagerCompat.from(context).cancel(TAG, notificationId(hostId, contentId))
  }

  private fun openTerminalIntent(hostId: String?, tab: AwaitingTab): PendingIntent {
    val intent = Intent(context, MainActivity::class.java)
      .setAction(ACTION_OPEN_TERMINAL)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_HOST_ID, hostId.orEmpty())
      .putExtra(EXTRA_CONTENT_ID, tab.contentId)
      .putExtra(EXTRA_TAB_TITLE, tab.tabTitle)
      .putExtra(EXTRA_REPOSITORY_ID, tab.repositoryId)
      .putExtra(EXTRA_WORKTREE_ID, tab.worktreeId)
      .putExtra(EXTRA_WORKTREE_NAME, tab.worktreeName)
    return PendingIntent.getActivity(
      context,
      notificationId(hostId, tab.contentId),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  companion object {
    const val CHANNEL_AWAITING = "agent_awaiting"
    const val CHANNEL_WATCH = "agent_watch"
    private const val TAG = "awaiting"

    const val ACTION_OPEN_TERMINAL = "com.idachev.supacoderemote.OPEN_TERMINAL"
    const val EXTRA_HOST_ID = "hostId"
    const val EXTRA_CONTENT_ID = "contentId"
    const val EXTRA_TAB_TITLE = "tabTitle"
    const val EXTRA_REPOSITORY_ID = "repositoryId"
    const val EXTRA_WORKTREE_ID = "worktreeId"
    const val EXTRA_WORKTREE_NAME = "worktreeName"

    /** Id на известието и request code на intent-а му: едно и също, за да се махат заедно. */
    fun notificationId(hostId: String?, contentId: String): Int = (hostId.orEmpty() + contentId).hashCode()

    fun canPost(context: Context): Boolean =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED

    fun createChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_AWAITING, "Агент чака вход", NotificationManager.IMPORTANCE_HIGH),
      )
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_WATCH, "Следене на агентите", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Постоянното известие, докато връзката с Mac-а е отворена във фон"
        },
      )
    }
  }
}
