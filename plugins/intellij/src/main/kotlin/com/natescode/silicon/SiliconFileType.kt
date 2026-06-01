package com.natescode.silicon

import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

/**
 * The `.si` file type.  Registered in plugin.xml so the IDE associates the
 * Silicon language (and its highlighter / LSP) with these files.
 */
object SiliconFileType : LanguageFileType(SiliconLanguage) {
    override fun getName(): String = "Silicon"
    override fun getDescription(): String = "Silicon source file"
    override fun getDefaultExtension(): String = "si"
    override fun getIcon(): Icon = SiliconIcons.FILE
}
