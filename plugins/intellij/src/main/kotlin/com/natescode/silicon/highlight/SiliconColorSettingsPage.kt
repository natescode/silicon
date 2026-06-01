package com.natescode.silicon.highlight

import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.options.colors.AttributesDescriptor
import com.intellij.openapi.options.colors.ColorDescriptor
import com.intellij.openapi.options.colors.ColorSettingsPage
import com.natescode.silicon.SiliconIcons
import javax.swing.Icon

/**
 * Backs *Settings | Editor | Color Scheme | Silicon* — the demo text drives the
 * preview pane and each [AttributesDescriptor] becomes an editable colour row.
 */
class SiliconColorSettingsPage : ColorSettingsPage {

    override fun getDisplayName(): String = "Silicon"
    override fun getIcon(): Icon = SiliconIcons.FILE
    override fun getHighlighter(): SyntaxHighlighter = SiliconSyntaxHighlighter()
    override fun getAdditionalHighlightingTagToDescriptorMap(): Map<String, TextAttributesKey>? = null
    override fun getColorDescriptors(): Array<ColorDescriptor> = ColorDescriptor.EMPTY_ARRAY
    override fun getAttributeDescriptors(): Array<AttributesDescriptor> = DESCRIPTORS

    override fun getDemoText(): String = """
        ## Doc comment: a tiny Silicon sample.
        # Line comment.
        @use std::io;

        @type Shape := ${'$'}Circle r:Int | ${'$'}Rectangle w:Int, h:Int;

        @fn area shape:Shape -> Float := &@match shape,
            ${'$'}Circle r => &@toFloat (r * r * 3),
            ${'$'}Rectangle w, h => &@toFloat (w * h)

        @fn main := {
            @let ok := @true;
            @let n := 0x1F + 42 - 3.14;
            @loop &@if ok, { &print 'Hello, Silicon!\n' }, { &@break }
        }
    """.trimIndent()

    private companion object {
        val DESCRIPTORS = arrayOf(
            AttributesDescriptor("Comments//Line comment", SiliconSyntaxHighlighter.LINE_COMMENT),
            AttributesDescriptor("Comments//Doc comment", SiliconSyntaxHighlighter.DOC_COMMENT),
            AttributesDescriptor("String literal", SiliconSyntaxHighlighter.STRING),
            AttributesDescriptor("Number", SiliconSyntaxHighlighter.NUMBER),
            AttributesDescriptor("Boolean literal", SiliconSyntaxHighlighter.BOOLEAN),
            AttributesDescriptor("Keywords//Definition (@fn, @let, @type)", SiliconSyntaxHighlighter.KW_DEFINITION),
            AttributesDescriptor("Keywords//Control flow (@if, @loop, @match)", SiliconSyntaxHighlighter.KW_CONTROL),
            AttributesDescriptor("Keywords//Stratum definer", SiliconSyntaxHighlighter.KW_STRATUM),
            AttributesDescriptor("Keywords//Cast (@toInt, @toFloat)", SiliconSyntaxHighlighter.KW_CAST),
            AttributesDescriptor("Keywords//Import (@use)", SiliconSyntaxHighlighter.KW_IMPORT),
            AttributesDescriptor("Keywords//Other annotation", SiliconSyntaxHighlighter.KW_OTHER),
            AttributesDescriptor("Call sigil (&)", SiliconSyntaxHighlighter.AMP),
            AttributesDescriptor("Function name", SiliconSyntaxHighlighter.FUNCTION),
            AttributesDescriptor("Type name", SiliconSyntaxHighlighter.TYPE),
            AttributesDescriptor("Variant sigil (${'$'})", SiliconSyntaxHighlighter.DOLLAR),
            AttributesDescriptor("Operator", SiliconSyntaxHighlighter.OPERATOR),
            AttributesDescriptor("Punctuation", SiliconSyntaxHighlighter.PUNCTUATION),
            AttributesDescriptor("Identifier", SiliconSyntaxHighlighter.IDENTIFIER),
            AttributesDescriptor("Bad character", SiliconSyntaxHighlighter.BAD_CHARACTER),
        )
    }
}
