package com.idachev.supacoderemote.ui.terminal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.idachev.supacoderemote.ui.LocalAppContainer

/**
 * Текстът на терминала като обикновен, маркируем текст: продължително натискане маркира
 * и копира както навсякъде в Android, „Копирай всичко“ взима целия текст. Отваря се в
 * края, при последните редове.
 */
@Composable
fun CopyTextDialog(text: String, onDismiss: () -> Unit) {
  val clipboard = LocalClipboardManager.current
  val notices = LocalAppContainer.current.notices
  val scroll = rememberScrollState()
  LaunchedEffect(text) { scroll.scrollTo(scroll.maxValue) }

  Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
    Surface(modifier = Modifier.fillMaxSize().testTag("copy-dialog")) {
      Column(Modifier.fillMaxSize()) {
        Row(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          TextButton(onClick = onDismiss) { Text("Затвори") }
          Text(
            "Задръж за маркиране",
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.weight(1f),
          )
          Button(
            onClick = {
              clipboard.setText(AnnotatedString(text))
              notices.show("Копирано")
              onDismiss()
            },
            modifier = Modifier.testTag("copy-all"),
          ) { Text("Копирай всичко") }
        }
        SelectionContainer(Modifier.weight(1f).fillMaxWidth()) {
          Text(
            text = text.ifEmpty { "(терминалът е празен)" },
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 15.sp,
            modifier = Modifier.verticalScroll(scroll).padding(12.dp).testTag("copy-text"),
          )
        }
      }
    }
  }
}
