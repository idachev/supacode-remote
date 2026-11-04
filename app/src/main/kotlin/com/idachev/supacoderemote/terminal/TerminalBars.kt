package com.idachev.supacoderemote.terminal

/**
 * Кои ленти се виждат около терминала: горната лента (заглавие, „Назад“, „Копирай“) и
 * полето за писане с реда с клавиши. По подразбиране и двете са скрити, за да вземе
 * терминалът целия екран; показват се с плаващите бутони върху него.
 *
 * Помни се за целия процес ([com.idachev.supacoderemote.AppContainer.terminalBars]), а не
 * за един таб: следващият отворен таб тръгва така, както е оставен последният.
 */
data class TerminalBars(
  val topBar: Boolean = false,
  val input: Boolean = false,
)
