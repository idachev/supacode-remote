package com.idachev.supacoderemote.ui.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.idachev.supacoderemote.sessions.NewWorktreeDialog
import com.idachev.supacoderemote.sessions.WorktreeName

/**
 * „Нов worktree в <repository>“ (ЗД11): едно поле за името на branch-а. Подсказката е от
 * телефона ([WorktreeName]), грешката — от Mac-а. „Не чакай“ само спира чакането тук: Mac-ът
 * продължава да създава.
 */
@Composable
fun NewWorktreeDialogView(
  dialog: NewWorktreeDialog,
  existing: List<String>,
  connected: Boolean,
  onName: (String) -> Unit,
  onCreate: () -> Unit,
  onDismiss: () -> Unit,
) {
  val hint = WorktreeName.hint(dialog.name, existing)
  // Празното поле не е грешка: бутонът е изключен, а подсказката чака първата буква.
  val shownHint = hint.takeIf { dialog.name.isNotBlank() }
  val canCreate = !dialog.pending && hint == null && connected
  val focus = remember { FocusRequester() }
  LaunchedEffect(Unit) { focus.requestFocus() }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("Нов worktree в ${dialog.repositoryName}") },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
          value = dialog.name,
          onValueChange = onName,
          label = { Text("Име на branch") },
          placeholder = { Text("напр. feature-x") },
          singleLine = true,
          enabled = !dialog.pending,
          isError = shownHint != null || dialog.error != null,
          textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
          keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Ascii,
            imeAction = ImeAction.Done,
          ),
          keyboardActions = KeyboardActions(onDone = { if (canCreate) onCreate() }),
          modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("worktree-name"),
        )
        shownHint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        dialog.error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error) }
        Text(
          "Mac-ът създава worktree-то като бутона в Supacode, избира го и отваря първия му таб.",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    },
    confirmButton = {
      TextButton(onClick = onCreate, enabled = canCreate) {
        if (dialog.pending) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
            Text("Създавам…")
          }
        } else {
          Text("Създай")
        }
      }
    },
    dismissButton = { TextButton(onClick = onDismiss) { Text(if (dialog.pending) "Не чакай" else "Затвори") } },
  )
}
