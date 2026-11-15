package au.com.vodalens

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance

/** Semantic accents stay useful even when the system's wallpaper palette is monochrome. */
internal object LensAccents {
    fun readable(accent: Color, background: Color): Color {
        fun contrast(color: Color): Float {
            val a = color.luminance(); val b = background.luminance()
            return (maxOf(a,b) + .05f) / (minOf(a,b) + .05f)
        }
        if(contrast(accent) >= 4.5f) return accent
        val target = if(background.luminance() > .179f) Color.Black else Color.White
        return (1..20).map { lerp(accent, target, it / 20f) }.firstOrNull { contrast(it) >= 4.5f } ?: target
    }
    fun data(onLight: Boolean) = Color(if(onLight) 0xFF00655A else 0xFF63DECB)
    fun cycle(onLight: Boolean) = Color(if(onLight) 0xFF3949AB else 0xFFB6C4FF)
    fun service(index: Int, onLight: Boolean): Color = when(index.mod(3)) {
        0 -> Color(if(onLight) 0xFF2159A6 else 0xFF9BC6FF)
        1 -> Color(if(onLight) 0xFF7542A2 else 0xFFD5B0FF)
        else -> Color(if(onLight) 0xFF9A4B0C else 0xFFFFBB85)
    }
    fun successContainer(dark: Boolean) = Color(if(dark) 0xFF123D2B else 0xFFD9F2E1)
    fun successText(dark: Boolean) = Color(if(dark) 0xFFA3E9BB else 0xFF165932)
    fun cautionContainer(dark: Boolean) = Color(if(dark) 0xFF46320D else 0xFFFFEBC7)
    fun cautionText(dark: Boolean) = Color(if(dark) 0xFFFFD58F else 0xFF6B4400)
    fun noticeContainer(dark: Boolean) = Color(if(dark) 0xFF382D17 else 0xFFFFF1CE)
    fun noticeText(dark: Boolean) = Color(if(dark) 0xFFF7DFA4 else 0xFF674600)
}
