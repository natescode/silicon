package com.natescode.silicon.highlight

import com.intellij.lexer.Lexer
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as D
import com.intellij.openapi.editor.HighlighterColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.colors.TextAttributesKey.createTextAttributesKey as key
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.psi.tree.IElementType
import com.natescode.silicon.lexer.SiliconLexer
import com.natescode.silicon.lexer.SiliconTokenTypes as T

/**
 * Maps [SiliconLexer] tokens to colour attributes, each fallback-linked to a
 * stock [DefaultLanguageHighlighterColors][D] key so Silicon inherits sensible
 * colours from whatever theme is active, while remaining individually
 * overridable in *Settings | Editor | Color Scheme | Silicon*.
 */
class SiliconSyntaxHighlighter : SyntaxHighlighterBase() {

    override fun getHighlightingLexer(): Lexer = SiliconLexer()

    override fun getTokenHighlights(tokenType: IElementType): Array<TextAttributesKey> =
        ATTRIBUTES[tokenType]?.let { arrayOf(it) } ?: EMPTY

    companion object {
        private val EMPTY = emptyArray<TextAttributesKey>()

        val LINE_COMMENT = key("SILICON_LINE_COMMENT", D.LINE_COMMENT)
        val DOC_COMMENT = key("SILICON_DOC_COMMENT", D.DOC_COMMENT)
        val STRING = key("SILICON_STRING", D.STRING)
        val NUMBER = key("SILICON_NUMBER", D.NUMBER)
        val BOOLEAN = key("SILICON_BOOLEAN", D.CONSTANT)
        val KW_DEFINITION = key("SILICON_KW_DEFINITION", D.KEYWORD)
        val KW_STRATUM = key("SILICON_KW_STRATUM", D.KEYWORD)
        val KW_CONTROL = key("SILICON_KW_CONTROL", D.KEYWORD)
        val KW_CAST = key("SILICON_KW_CAST", D.KEYWORD)
        val KW_IMPORT = key("SILICON_KW_IMPORT", D.KEYWORD)
        val KW_OTHER = key("SILICON_KW_OTHER", D.METADATA)
        val AMP = key("SILICON_AMP", D.OPERATION_SIGN)
        val FUNCTION = key("SILICON_FUNCTION", D.FUNCTION_CALL)
        val TYPE = key("SILICON_TYPE", D.CLASS_NAME)
        val DOLLAR = key("SILICON_DOLLAR", D.LABEL)
        val OPERATOR = key("SILICON_OPERATOR", D.OPERATION_SIGN)
        val PUNCTUATION = key("SILICON_PUNCTUATION", D.SEMICOLON)
        val IDENTIFIER = key("SILICON_IDENTIFIER", D.IDENTIFIER)
        val BAD_CHARACTER = key("SILICON_BAD_CHARACTER", HighlighterColors.BAD_CHARACTER)

        private val ATTRIBUTES: Map<IElementType, TextAttributesKey> = mapOf(
            T.LINE_COMMENT to LINE_COMMENT,
            T.DOC_COMMENT to DOC_COMMENT,
            T.STRING to STRING,
            T.NUMBER to NUMBER,
            T.BOOLEAN to BOOLEAN,
            T.KW_DEFINITION to KW_DEFINITION,
            T.KW_STRATUM to KW_STRATUM,
            T.KW_CONTROL to KW_CONTROL,
            T.KW_CAST to KW_CAST,
            T.KW_IMPORT to KW_IMPORT,
            T.KW_OTHER to KW_OTHER,
            T.AMP to AMP,
            T.FUNCTION to FUNCTION,
            T.TYPE to TYPE,
            T.DOLLAR to DOLLAR,
            T.OPERATOR to OPERATOR,
            T.PUNCTUATION to PUNCTUATION,
            T.IDENTIFIER to IDENTIFIER,
            T.BAD_CHARACTER to BAD_CHARACTER,
        )
    }
}
