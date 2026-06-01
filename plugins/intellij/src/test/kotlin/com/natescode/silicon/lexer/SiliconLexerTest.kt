package com.natescode.silicon.lexer

import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * Drives [SiliconLexer] directly (no IDE boot required) and checks the token
 * stream.  Whitespace is dropped so assertions read cleanly.
 */
class SiliconLexerTest {

    private data class Tok(val type: IElementType, val text: String)

    private fun lex(src: String): List<Tok> {
        val lexer = SiliconLexer()
        lexer.start(src, 0, src.length, 0)
        val out = mutableListOf<Tok>()
        while (lexer.tokenType != null) {
            val t = lexer.tokenType!!
            if (t != TokenType.WHITE_SPACE) {
                out += Tok(t, src.substring(lexer.tokenStart, lexer.tokenEnd))
            }
            lexer.advance()
        }
        return out
    }

    private fun types(src: String) = lex(src).map { it.type }

    @Test fun `comments`() {
        assertEquals(
            listOf(SiliconTokenTypes.DOC_COMMENT, SiliconTokenTypes.LINE_COMMENT),
            types("## doc\n# line"),
        )
    }

    @Test fun `keyword families`() {
        val T = SiliconTokenTypes
        assertEquals(
            listOf(T.KW_DEFINITION, T.KW_CONTROL, T.KW_CAST, T.KW_IMPORT, T.KW_STRATUM, T.KW_OTHER),
            types("@fn @if @toInt @use @stratum_keyword @whatever"),
        )
    }

    @Test fun `booleans are not keywords`() {
        assertEquals(listOf(SiliconTokenTypes.BOOLEAN, SiliconTokenTypes.BOOLEAN), types("@true @false"))
    }

    @Test fun `call sigil colours the following name as a function`() {
        val toks = lex("&foo &@if &mod::bar")
        val T = SiliconTokenTypes
        assertEquals(
            listOf(
                T.AMP, T.FUNCTION,                 // &foo
                T.AMP, T.KW_CONTROL,               // &@if  (keyword keeps keyword colour)
                T.AMP, T.FUNCTION, T.OPERATOR, T.IDENTIFIER, // &mod::bar
            ),
            toks.map { it.type },
        )
    }

    @Test fun `numbers`() {
        val T = SiliconTokenTypes
        assertEquals(
            listOf(T.NUMBER, T.NUMBER, T.NUMBER, T.NUMBER, T.NUMBER),
            types("42 3.14 0xFF_00 0b1010 0c755"),
        )
    }

    @Test fun `types vs identifiers`() {
        assertEquals(
            listOf(SiliconTokenTypes.TYPE, SiliconTokenTypes.IDENTIFIER),
            types("Shape area"),
        )
    }

    @Test fun `dollar variant sigil and operators`() {
        val T = SiliconTokenTypes
        assertEquals(
            listOf(T.DOLLAR, T.TYPE, T.OPERATOR, T.OPERATOR),
            types("\$Circle := =>"),
        )
    }

    @Test fun `string literal with escape stays one token`() {
        val toks = lex("'hi\\n'")
        assertEquals(1, toks.size)
        assertEquals(SiliconTokenTypes.STRING, toks[0].type)
        assertEquals("'hi\\n'", toks[0].text)
    }

    @Test fun `restart from after-amp state is stable`() {
        // Emulate the incremental highlighter restarting mid-stream: lex "&foo",
        // capture the state after "&", then restart the tail with that state.
        val src = "&foo"
        val lexer = SiliconLexer()
        lexer.start(src, 0, src.length, 0)        // token "&"
        val stateAfterAmp = lexer.state
        lexer.advance()                            // token "foo"
        assertEquals(SiliconTokenTypes.FUNCTION, lexer.tokenType)

        val tail = SiliconLexer()
        tail.start(src, 1, src.length, stateAfterAmp)
        assertEquals(SiliconTokenTypes.FUNCTION, tail.tokenType)
    }
}
