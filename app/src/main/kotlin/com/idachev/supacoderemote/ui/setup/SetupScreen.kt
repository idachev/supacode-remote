package com.idachev.supacoderemote.ui.setup

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Switch
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.idachev.supacoderemote.alerts.AgentAlerts
import com.idachev.supacoderemote.alerts.AgentWatchService
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.idachev.supacoderemote.BuildConfig
import com.idachev.supacoderemote.protocol.ConnectionKey
import com.idachev.supacoderemote.ui.LocalAppContainer

/**
 * „Известия, когато агент чака“. Важи веднага, без „Запази“: включването пуска
 * foreground service-а, изключването го спира. На Android 13+ първо иска разрешение.
 */
@Composable
private fun NotifyAwaitingRow() {
  val container = LocalAppContainer.current
  val context = LocalContext.current
  val enabled by container.settingsStore.notifyAwaiting.collectAsStateWithLifecycle()

  fun apply(on: Boolean) {
    container.settingsStore.setNotifyAwaiting(on)
    AgentWatchService.sync(context, on)
  }

  val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) apply(true) else container.notices.show("Без разрешение за известия не мога да известявам")
  }

  Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.weight(1f)) {
      Text("Известия, когато агент чака", style = MaterialTheme.typography.bodyLarge)
      Text(
        "Връзката остава отворена във фон и на 15 s проверява табовете. Постоянно известие показва, че работи.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    Switch(
      checked = enabled,
      onCheckedChange = { on ->
        if (on && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !AgentAlerts.canPost(context)) {
          permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
          apply(on)
        }
      },
      modifier = Modifier.testTag("setup-notify"),
    )
  }
}

/** „Скрол стига до агента“: скрол отвъд историята на телефона праща PgUp / PgDn. */
@Composable
private fun OverscrollRow() {
  val store = LocalAppContainer.current.settingsStore
  val enabled by store.overscrollToProgram.collectAsStateWithLifecycle()
  Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.weight(1f)) {
      Text("Скрол стига до агента", style = MaterialTheme.typography.bodyLarge)
      Text(
        "В началото или края на историята на телефона още скрол праща PgUp / PgDn, за да " +
          "превърти историята на самата програма (напр. Claude Code).",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    Switch(checked = enabled, onCheckedChange = store::setOverscrollToProgram, modifier = Modifier.testTag("setup-overscroll"))
  }
}

/**
 * „Настройка“: ключът за връзка `<relay>/<клиентски ключ>`. Пише се (или се поставя)
 * веднъж, сменя се оттук. Записани по-рано адрес и ключ се показват в същия вид.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(wrongKey: Boolean, canGoBack: Boolean, onBack: () -> Unit, onSaved: () -> Unit) {
  val container = LocalAppContainer.current
  val current = container.settingsStore.settings.value
  var connectionKey by rememberSaveable { mutableStateOf(current?.let(ConnectionKey::format).orEmpty()) }
  var showKey by rememberSaveable { mutableStateOf(false) }
  var error by rememberSaveable { mutableStateOf(if (wrongKey) "Relay-ът не прие ключа (401). Провери го." else null) }
  val parsed = ConnectionKey.parse(connectionKey)

  fun save() {
    val settings = parsed
    if (settings == null) {
      error = "Ключът е „relay/ключ“, напр. relay.example.com/abcde-fghij-…"
      return
    }
    container.settingsStore.save(settings)
    // Същите настройки след 401 не дават ново събитие в потока — затова и направо.
    container.relay.configure(settings)
    onSaved()
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Настройка") },
        navigationIcon = { if (canGoBack) TextButton(onClick = onBack) { Text("Назад") } },
      )
    },
  ) { padding ->
    Column(
      verticalArrangement = Arrangement.spacedBy(16.dp),
      modifier = Modifier
        .fillMaxSize()
        .padding(padding)
        .imePadding()
        .verticalScroll(rememberScrollState())
        .padding(16.dp),
    ) {
      Text(
        "Supacode Remote се свързва с Mac-а през relay-а. Ключът за връзка е в " +
          "~/.config/supacode/remote-client-key.txt на Mac-а — копирай го целия.",
        style = MaterialTheme.typography.bodyMedium,
      )
      OutlinedTextField(
        value = connectionKey,
        onValueChange = { connectionKey = it; error = null },
        label = { Text("Ключ за връзка") },
        placeholder = { Text("relay.example.com/abcde-fghij-…", fontFamily = FontFamily.Monospace) },
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        visualTransformation = if (showKey) VisualTransformation.None else KeyOnlyMask,
        // Без автокорекция и главни букви: ключът се поставя или пише буква по буква.
        keyboardOptions = KeyboardOptions(
          capitalization = KeyboardCapitalization.None,
          autoCorrectEnabled = false,
          // Password: клавиатурата не учи ключа и не предлага думи; поставянето работи.
          keyboardType = KeyboardType.Password,
          imeAction = ImeAction.Done,
        ),
        trailingIcon = { TextButton(onClick = { showKey = !showKey }) { Text(if (showKey) "Скрий" else "Покажи") } },
        supportingText = {
          Text(
            when {
              connectionKey.isBlank() -> "Relay и ключ, разделени с „/“"
              parsed != null -> "Relay: ${ConnectionKey.relayLabel(parsed.baseUrl)}"
              else -> "Липсва relay или ключ"
            },
          )
        },
        isError = connectionKey.isNotBlank() && parsed == null,
        modifier = Modifier.fillMaxWidth().testTag("setup-connection-key"),
      )
      error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
      Button(onClick = ::save, modifier = Modifier.fillMaxWidth().testTag("setup-save")) { Text("Запази и свържи") }
      NotifyAwaitingRow()
      OverscrollRow()
      Text(
        "Версия ${BuildConfig.VERSION_NAME} · ${BuildConfig.GIT_SHORT_SHA} · ${BuildConfig.BUILD_TIME_UTC}",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

/**
 * Скрива само ключа: relay-ят (до последната `/`) остава видим, за да се вижда къде отива
 * връзката. Дължината не се сменя, затова курсорът е на същото място.
 */
private val KeyOnlyMask = VisualTransformation { text ->
  val slash = text.text.lastIndexOf('/')
  val masked = text.text.mapIndexed { i, ch -> if (i > slash) '•' else ch }.joinToString("")
  TransformedText(AnnotatedString(masked), OffsetMapping.Identity)
}
