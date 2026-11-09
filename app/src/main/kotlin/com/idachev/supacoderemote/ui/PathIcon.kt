package com.idachev.supacoderemote.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Икона 24 × 24 от един път на Material Icons (Filled). Пътищата се копират в кода, а не от
 * `material-icons-extended`: иконите са няколко, а библиотеката е хиляди. Цветът идва от `tint`.
 */
fun pathIcon(name: String, path: String): ImageVector =
  ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
    .addPath(addPathNodes(path), fill = SolidColor(Color.Black))
    .build()
