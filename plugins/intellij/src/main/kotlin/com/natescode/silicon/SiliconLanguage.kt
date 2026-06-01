package com.natescode.silicon

import com.intellij.lang.Language

/**
 * The Silicon language singleton.  Used to tag the file type, the syntax
 * highlighter, and the LSP4IJ language mapping.
 */
object SiliconLanguage : Language("Silicon") {
    private fun readResolve(): Any = SiliconLanguage
    override fun getDisplayName(): String = "Silicon"
    override fun isCaseSensitive(): Boolean = true
}
