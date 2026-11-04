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
import kotlinx.coroutines.launch

/**
 * Известията „агент чака“. Гледа всеки нов `list`, докато превключвателят в „Настройка“
 * е включен. Известие се пуска само когато приложението не се вижда — пред очите на потребителя
 * значката в списъка стига; но и тогава преходът се запомня, за да не дойде известие
 * по-късно за нещо, което той вече е видял.
 */
class AgentAlerts(
  private val context: Context,
  private val repos: StateFlow<List<Repository>?>,
  private val appInForeground: StateFlow<Boolean>,
  private val scope: CoroutineScope,
) {

  private var job: Job? = null

  fun setEnabled(enabled: Boolean) {
    job?.cancel()
    job = null
    if (!enabled) return
    createChannels(context)
    // Нов tracker при всяко включване: чакащите в този момент дават известие, ако сме във фон.
    val tracker = AwaitingTracker()
    job = scope.launch {
      repos.filterNotNull().collect { list ->
        val changes = tracker.update(list)
        changes.ended.forEach { cancel(it) }
        if (!appInForeground.value) changes.started.forEach { post(it) }
      }
    }
  }

  private fun post(tab: AwaitingTab) {
    if (!canPost(context)) return
    val notification = NotificationCompat.Builder(context, CHANNEL_AWAITING)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("${tab.worktreeName} · ${tab.tabTitle}")
      .setContentText("${tab.agent} чака вход")
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(openTerminalIntent(tab))
      .build()
    NotificationManagerCompat.from(context).notify(TAG, tab.contentId.hashCode(), notification)
  }

  private fun cancel(contentId: String) {
    NotificationManagerCompat.from(context).cancel(TAG, contentId.hashCode())
  }

  private fun openTerminalIntent(tab: AwaitingTab): PendingIntent {
    val intent = Intent(context, MainActivity::class.java)
      .setAction(ACTION_OPEN_TERMINAL)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_CONTENT_ID, tab.contentId)
      .putExtra(EXTRA_TAB_TITLE, tab.tabTitle)
      .putExtra(EXTRA_REPOSITORY_ID, tab.repositoryId)
      .putExtra(EXTRA_WORKTREE_ID, tab.worktreeId)
      .putExtra(EXTRA_WORKTREE_NAME, tab.worktreeName)
    return PendingIntent.getActivity(
      context,
      tab.contentId.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  companion object {
    const val CHANNEL_AWAITING = "agent_awaiting"
    const val CHANNEL_WATCH = "agent_watch"
    private const val TAG = "awaiting"

    const val ACTION_OPEN_TERMINAL = "com.idachev.supacoderemote.OPEN_TERMINAL"
    const val EXTRA_CONTENT_ID = "contentId"
    const val EXTRA_TAB_TITLE = "tabTitle"
    const val EXTRA_REPOSITORY_ID = "repositoryId"
    const val EXTRA_WORKTREE_ID = "worktreeId"
    const val EXTRA_WORKTREE_NAME = "worktreeName"

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
