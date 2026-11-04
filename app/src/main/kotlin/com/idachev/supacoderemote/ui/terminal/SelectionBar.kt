package com.idachev.supacoderemote.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Лентата за маркиране: стои в Compose над WebView-то, а не в страницата, затова е с един
 * и същ размер при всеки pinch zoom. ◀ ▶ местят началото или края с една клетка (задържане
 * повтаря), така че маркираното се нагласява точно и без zoom. „Копирай“ взема точно
 * показаното.
 */
@Composable
fun SelectionBar(
  onMoveStart: (Int) -> Unit,
  onMoveEnd: (Int) -> Unit,
  onCopy: () -> Unit,
  onCancel: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    shape = RoundedCornerShape(16.dp),
    color = MaterialTheme.colorScheme.surfaceContainerHigh,
    tonalElevation = 3.dp,
    shadowElevation = 6.dp,
    modifier = modifier.testTag("selection-bar"),
  ) {
    Column(
      verticalArrangement = Arrangement.spacedBy(8.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      modifier = Modifier.padding(10.dp),
    ) {
      Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        SelectionEnd(
          label = "Начало",
          what = "началото",
          tag = "sel-start",
          onMove = onMoveStart,
        )
        SelectionEnd(
          label = "Край",
          what = "края",
          tag = "sel-end",
          onMove = onMoveEnd,
        )
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = onCancel, modifier = Modifier.testTag("sel-cancel")) { Text("Отказ") }
        Button(onClick = onCopy, modifier = Modifier.testTag("sel-copy")) { Text("Копирай") }
      }
    }
  }
}

/** Един край на маркираното: надпис и ◀ ▶ под него. */
@Composable
private fun SelectionEnd(label: String, what: String, tag: String, onMove: (Int) -> Unit) {
  Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      SelectionStepButton("◀", "Премести $what с един знак наляво", "$tag-left") { onMove(-1) }
      SelectionStepButton("▶", "Премести $what с един знак надясно", "$tag-right") { onMove(1) }
    }
  }
}

@Composable
private fun SelectionStepButton(symbol: String, description: String, tag: String, onFire: () -> Unit) {
  Box(
    contentAlignment = Alignment.Center,
    modifier = Modifier
      .size(width = 56.dp, height = 44.dp)
      .background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(12.dp))
      .testTag(tag)
      .repeatPress(description, onFire),
  ) {
    Text(symbol, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
  }
}

/**
 * Натискане, което се повтаря, докато се държи: първо веднъж, после след
 * [REPEAT_FIRST_MS] на всеки [REPEAT_MS]. За TalkBack е обикновен бутон с [description].
 */
@Composable
fun Modifier.repeatPress(description: String?, onFire: () -> Unit): Modifier {
  val currentOnFire by rememberUpdatedState(onFire)
  return this
    .semantics {
      role = Role.Button
      if (description != null) contentDescription = description
      onClick { currentOnFire(); true }
    }
    .pointerInput(Unit) {
      coroutineScope {
        awaitEachGesture {
          awaitFirstDown()
          currentOnFire()
          val repeat = launch {
            delay(REPEAT_FIRST_MS)
            while (true) {
              currentOnFire()
              delay(REPEAT_MS)
            }
          }
          waitForUpOrCancellation()
          repeat.cancel()
        }
      }
    }
}

private const val REPEAT_FIRST_MS = 400L
private const val REPEAT_MS = 150L
