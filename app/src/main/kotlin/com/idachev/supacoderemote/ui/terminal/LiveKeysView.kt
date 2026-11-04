package com.idachev.supacoderemote.ui.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.text.InputType
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import com.idachev.supacoderemote.terminal.LiveKeys

/**
 * Невидимото поле за „Живи клавиши“: само приема клавиатурата и подава всяка промяна на
 * [LiveKeys]. Своя `InputConnection`, а не `EditText`, за да се вижда всяка стъпка на IME-а
 * (composing, commit, триене) и полето да остава празно след всеки изпратен знак.
 */
@SuppressLint("ViewConstructor")
class LiveKeysView(context: Context, private val keys: LiveKeys) : View(context) {

  init {
    isFocusable = true
    isFocusableInTouchMode = true
  }

  override fun onCheckIsTextEditor(): Boolean = true

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
    // Без подсказки, автокорекция и учене: всяка буква отива в терминала, а паролите и
    // командите не трябва да влизат в речника на клавиатурата. Не visible-password: при него
    // Gboard минава на латиница и кирилицата става невъзможна.
    outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or
      EditorInfo.IME_FLAG_NO_EXTRACT_UI or
      EditorInfo.IME_FLAG_NO_FULLSCREEN or
      EditorInfo.IME_ACTION_NONE
    outAttrs.initialSelStart = 0
    outAttrs.initialSelEnd = 0
    return Connection()
  }

  /** Показва клавиатурата за това поле. */
  fun showKeyboard() {
    requestFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    imm.restartInput(this)
    imm.showSoftInput(this, 0)
  }

  fun hideKeyboard() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    imm.hideSoftInputFromWindow(windowToken, 0)
    clearFocus()
  }

  /** Клавиши, които не минават през IME-а: физическа клавиатура и `adb shell input`. */
  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = handleKey(event) || super.onKeyDown(keyCode, event)

  private fun handleKey(event: KeyEvent): Boolean {
    if (event.action != KeyEvent.ACTION_DOWN) return false
    when (event.keyCode) {
      KeyEvent.KEYCODE_DEL -> keys.key(LiveKeys.Key.Backspace)
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> keys.key(LiveKeys.Key.Enter)
      else -> {
        val ch = event.getUnicodeChar(event.metaState)
        if (ch == 0 || ch and KeyCharacterMap.COMBINING_ACCENT != 0) return false
        keys.key(LiveKeys.Key.Text(String(Character.toChars(ch))))
      }
    }
    return true
  }

  private inner class Connection : BaseInputConnection(this@LiveKeysView, true) {

    override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
      keys.setComposing(text.toString())
      return super.setComposingText(text, newCursorPosition)
    }

    override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
      keys.commit(text.toString())
      super.commitText(text, newCursorPosition)
      editable?.clear()
      return true
    }

    override fun finishComposingText(): Boolean {
      keys.finishComposing()
      super.finishComposingText()
      editable?.clear()
      return true
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
      keys.deleteBefore(beforeLength)
      return super.deleteSurroundingText(beforeLength, afterLength)
    }

    override fun sendKeyEvent(event: KeyEvent): Boolean {
      handleKey(event)
      return true
    }
  }
}
