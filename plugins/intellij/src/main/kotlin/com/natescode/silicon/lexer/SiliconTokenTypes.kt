package com.natescode.silicon.lexer

import com.intellij.psi.tree.IElementType
import com.natescode.silicon.SiliconLanguage

/** An [IElementType] tagged with the Silicon language. */
class SiliconTokenType(debugName: String) : IElementType(debugName, SiliconLanguage)

/**
 * The flat token vocabulary produced by [SiliconLexer].  These are colouring
 * tokens — there is no parser / PSI tree; the LSP supplies semantic features.
 */
object SiliconTokenTypes {
    @JvmField val LINE_COMMENT = SiliconTokenType("SI_LINE_COMMENT")
    @JvmField val DOC_COMMENT = SiliconTokenType("SI_DOC_COMMENT")
    @JvmField val STRING = SiliconTokenType("SI_STRING")
    @JvmField val NUMBER = SiliconTokenType("SI_NUMBER")
    @JvmField val BOOLEAN = SiliconTokenType("SI_BOOLEAN")

    // `@`-prefixed keyword families.
    @JvmField val KW_DEFINITION = SiliconTokenType("SI_KW_DEFINITION")
    @JvmField val KW_STRATUM = SiliconTokenType("SI_KW_STRATUM")
    @JvmField val KW_CONTROL = SiliconTokenType("SI_KW_CONTROL")
    @JvmField val KW_CAST = SiliconTokenType("SI_KW_CAST")
    @JvmField val KW_IMPORT = SiliconTokenType("SI_KW_IMPORT")
    @JvmField val KW_OTHER = SiliconTokenType("SI_KW_OTHER")

    @JvmField val AMP = SiliconTokenType("SI_AMP")           // `&` call sigil
    @JvmField val FUNCTION = SiliconTokenType("SI_FUNCTION") // name after `&`
    @JvmField val TYPE = SiliconTokenType("SI_TYPE")         // PascalCase / primitive
    @JvmField val DOLLAR = SiliconTokenType("SI_DOLLAR")     // `$` variant sigil
    @JvmField val OPERATOR = SiliconTokenType("SI_OPERATOR")
    @JvmField val PUNCTUATION = SiliconTokenType("SI_PUNCTUATION")
    @JvmField val IDENTIFIER = SiliconTokenType("SI_IDENTIFIER")

    @JvmField val BAD_CHARACTER = SiliconTokenType("SI_BAD_CHARACTER")
}
