// SPDX-License-Identifier: MIT
/**
 * Hand-written tokenizer for Silicon — zero dependencies.
 *
 * Companion to parser.ts (a recursive-descent LL(1) parser). Token shapes
 * follow the lexical rules of the current grammar (src/grammar/silicon-official.ohm
 * and docs/grammar.ebnf), with maximal-munch so the two tricky LL(1) spots are
 * decidable with one token of lookahead:
 *   - `=` (assignment) vs `==`/`<=`/… (operator run): a lone `=` is its own token.
 *   - `&@as` (ascription) vs `&@assert` (keyword call): the `@as` keyword token
 *     is matched whole, so the parser peeks one token to decide.
 *
 * Comments: a line starting with `#` (including `##`) is whitespace — this
 * matches ohm, where `comment = "#" …` is part of `space`, so `##` doc comments
 * are consumed as comments and never reach the parser as DocComment nodes.
 */

export type TokKind =
    | 'ident'        // identifier (letters/digits/underscore)
    | 'kw'           // @ident — keyword/defKw/boolean; text includes the '@'
    | 'op'           // maximal run of operator glyphs (= < > ! + - * / % ^ | ~ ?)
    | 'amp'          // & — call sigil
    | 'dollar'       // $ — variant sigil (followed by an identifier)
    | 'arrOpen'      // $[
    | 'objOpen'      // ${
    | 'tupOpen'      // $(
    | 'nsSep'        // :: or .
    | 'bind'         // :=
    | 'attachedSig'  // \\  (two backslashes)
    | 'lparen' | 'rparen' | 'lbrace' | 'rbrace' | 'lbrack' | 'rbrack'
    | 'comma' | 'semi'
    | 'string'       // '...'
    | 'int'          // decimal / 0b / 0x / 0c integer literal
    | 'float'        // digits "." digits
    | 'eof'

export interface Token {
    kind: TokKind
    /** Source text of the token (exact). For numeric tokens, the full literal. */
    text: string
    /** Start char offset (inclusive) into the source. */
    start: number
    /** End char offset (exclusive) into the source. */
    end: number
    /** For 'int' tokens, the recognised base. */
    base?: 'decimal' | 'binary' | 'hexadecimal' | 'octal'
    /** For '.'/'::' separators, which one. */
    sep?: '.' | '::'
}

const OP_GLYPHS = new Set(['=', '<', '>', '!', '+', '-', '*', '/', '%', '^', '|', '~', '?'])

function isLetter(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
function isDigit(c: string): boolean {
    return c >= '0' && c <= '9'
}
function isIdentStart(c: string): boolean {
    return isLetter(c) || c === '_'
}
function isIdentTail(c: string): boolean {
    return isLetter(c) || isDigit(c) || c === '_'
}
// Whitespace per the grammar (ohm `whitespace` + line terminators).
function isSpace(c: string): boolean {
    if (c === ' ' || c === '\t' || c === '\x0B' || c === '\x0C' || c === ' ' || c === '﻿') return true
    if (c === '\n' || c === '\r' || c === ' ' || c === ' ') return true
    if (c >= ' ' && c <= '​') return true
    if (c === '　') return true
    return false
}

export class Lexer {
    private i = 0
    constructor(private readonly src: string) {}

    /** Tokenize the whole source into an array ending with an `eof` token. */
    tokenize(): Token[] {
        const toks: Token[] = []
        for (;;) {
            const t = this.next()
            toks.push(t)
            if (t.kind === 'eof') break
        }
        return toks
    }

    private skipTrivia(): void {
        const s = this.src
        for (;;) {
            const c = s[this.i]
            if (c === undefined) return
            if (isSpace(c)) { this.i++; continue }
            if (c === '#') {
                // Line comment (covers `##` too) — consume to end of line.
                this.i++
                while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r'
                    && s[this.i] !== ' ' && s[this.i] !== ' ') this.i++
                continue
            }
            return
        }
    }

    private tok(kind: TokKind, start: number, extra?: Partial<Token>): Token {
        return { kind, text: this.src.slice(start, this.i), start, end: this.i, ...extra }
    }

    private next(): Token {
        this.skipTrivia()
        const s = this.src
        const start = this.i
        const c = s[this.i]
        if (c === undefined) return { kind: 'eof', text: '', start, end: start }

        // Two-backslash attached-signature sigil.
        if (c === '\\' && s[this.i + 1] === '\\') { this.i += 2; return this.tok('attachedSig', start) }

        // $ openers and variant sigil.
        if (c === '$') {
            const n = s[this.i + 1]
            if (n === '[') { this.i += 2; return this.tok('arrOpen', start) }
            if (n === '{') { this.i += 2; return this.tok('objOpen', start) }
            if (n === '(') { this.i += 2; return this.tok('tupOpen', start) }
            this.i++; return this.tok('dollar', start)
        }

        // @keyword (defKw / keyword / @true / @false). The leading '@' plus an
        // identifier; '@' alone is not a valid token.
        if (c === '@') {
            this.i++
            while (this.i < s.length && isIdentTail(s[this.i])) this.i++
            return this.tok('kw', start)
        }

        if (c === '&') { this.i++; return this.tok('amp', start) }

        // ':' → '::' (nsSep) or ':=' (bind).
        if (c === ':') {
            if (s[this.i + 1] === ':') { this.i += 2; return this.tok('nsSep', start, { sep: '::' }) }
            if (s[this.i + 1] === '=') { this.i += 2; return this.tok('bind', start) }
            // Bare ':' is not valid in the current grammar; surface it as an op
            // run of length 1 so the parser reports an unexpected token.
            this.i++; return this.tok('op', start)
        }

        // '.' as a namespace separator (numbers consume their own '.').
        if (c === '.') { this.i++; return this.tok('nsSep', start, { sep: '.' }) }

        if (c === '(') { this.i++; return this.tok('lparen', start) }
        if (c === ')') { this.i++; return this.tok('rparen', start) }
        if (c === '{') { this.i++; return this.tok('lbrace', start) }
        if (c === '}') { this.i++; return this.tok('rbrace', start) }
        if (c === '[') { this.i++; return this.tok('lbrack', start) }
        if (c === ']') { this.i++; return this.tok('rbrack', start) }
        if (c === ',') { this.i++; return this.tok('comma', start) }
        if (c === ';') { this.i++; return this.tok('semi', start) }

        // String literal '...': no escapes; closes at next quote / errors at EOL.
        if (c === "'") {
            this.i++
            while (this.i < s.length) {
                const ch = s[this.i]
                if (ch === "'" || ch === '\\' || ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ') break
                this.i++
            }
            if (s[this.i] !== "'") throw new Error(`Lex error: unterminated string at offset ${start}`)
            this.i++
            return this.tok('string', start)
        }

        // Numbers.
        if (isDigit(c)) return this.lexNumber(start)

        // Operator run (maximal munch).
        if (OP_GLYPHS.has(c)) {
            this.i++
            while (this.i < s.length && OP_GLYPHS.has(s[this.i])) this.i++
            return this.tok('op', start)
        }

        // Identifier.
        if (isIdentStart(c)) {
            this.i++
            while (this.i < s.length && isIdentTail(s[this.i])) this.i++
            return this.tok('ident', start)
        }

        throw new Error(`Lex error: unexpected character ${JSON.stringify(c)} at offset ${start}`)
    }

    private lexNumber(start: number): Token {
        // Matches ohm's effective behaviour: `intLiteral` tries `decLiteral`
        // first, so the prefixed bases (0x/0b/0c) are dead — a leading digit is
        // always decimal. So: decimal integer, then an optional `.digits`
        // fractional part makes it a float. No base prefixes.
        const s = this.src
        // Integer part: digit runs separated by single underscores.
        while (this.i < s.length && (isDigit(s[this.i]) || (s[this.i] === '_' && isDigit(s[this.i + 1])))) this.i++
        // Fractional part (ohm: `digit+` — no underscores) makes it a float.
        if (s[this.i] === '.' && isDigit(s[this.i + 1])) {
            this.i++ // dot
            while (this.i < s.length && isDigit(s[this.i])) this.i++
            return this.tok('float', start)
        }
        return this.tok('int', start, { base: 'decimal' })
    }
}

/** Convenience: tokenize a source string. */
export function tokenize(src: string): Token[] {
    return new Lexer(src).tokenize()
}

/** 1-based line/column for a char offset, matching ohm's getLineAndColumn:
 *  line increments on '\n'; '\r' does not advance the column. */
export function lineColumn(src: string, offset: number): { line: number; column: number } {
    let line = 1
    let column = 1
    const n = Math.min(offset, src.length)
    for (let i = 0; i < n; i++) {
        const c = src[i]
        if (c === '\n') { line++; column = 1 }
        else if (c !== '\r') { column++ }
    }
    return { line, column }
}
