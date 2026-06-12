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
 *
 * Hot character-classification uses ASCII lookup tables + charCodeAt (all
 * tokens are ASCII; non-ASCII only appears as whitespace or string bodies).
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
    | 'int'          // decimal integer literal
    | 'float'        // digits "." digits
    | 'eof'

export interface Token {
    kind: TokKind
    /** Source text of the token (exact). */
    text: string
    /** Start char offset (inclusive) into the source. */
    start: number
    /** End char offset (exclusive) into the source. */
    end: number
    /** For 'int' tokens, the recognised base (always 'decimal' in this grammar). */
    base?: 'decimal' | 'binary' | 'hexadecimal' | 'octal'
    /** For '.'/'::' separators, which one. */
    sep?: '.' | '::'
    /** True when skipped trivia before this token contained at least one newline. */
    leadingNewline?: boolean
}

// ── character classification (ASCII lookup tables, indexed by char code) ──────
const DIGIT = new Uint8Array(128)
const IDENT_START = new Uint8Array(128)
const IDENT_TAIL = new Uint8Array(128)
const OP_GLYPH = new Uint8Array(128)
const ASCII_SPACE = new Uint8Array(128)
for (let c = 48; c <= 57; c++) { DIGIT[c] = 1; IDENT_TAIL[c] = 1 }            // 0-9
for (let c = 65; c <= 90; c++) { IDENT_START[c] = 1; IDENT_TAIL[c] = 1 }      // A-Z
for (let c = 97; c <= 122; c++) { IDENT_START[c] = 1; IDENT_TAIL[c] = 1 }     // a-z
IDENT_START[95] = 1; IDENT_TAIL[95] = 1                                       // _
for (const ch of '=<>!+-*/%^|~?') OP_GLYPH[ch.charCodeAt(0)] = 1
for (const c of [9, 10, 11, 12, 13, 32]) ASCII_SPACE[c] = 1                   // \t \n \v \f \r space

// Char codes used by the scanner.
const NL = 10, CR = 13, LS = 0x2028, PS = 0x2029   // line terminators
const HASH = 35, QUOTE = 39, BACKSLASH = 92

/** Non-ASCII whitespace per the grammar: NBSP, BOM, U+2000–U+200B, U+3000. */
function isUnicodeSpace(code: number): boolean {
    return code === 0x00A0 || code === 0xFEFF || (code >= 0x2000 && code <= 0x200B) || code === 0x3000
}
function isSpaceCode(code: number): boolean {
    return code < 128 ? ASCII_SPACE[code] === 1 : isUnicodeSpace(code)
}
function isLineEnd(code: number): boolean {
    return code === NL || code === CR || code === LS || code === PS
}
function isDigit(c: string): boolean { const k = c.charCodeAt(0); return k < 128 && DIGIT[k] === 1 }
function isIdentStart(c: string): boolean { const k = c.charCodeAt(0); return k < 128 && IDENT_START[k] === 1 }

export class Lexer {
    private i = 0
    private skippedNewline = false
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
        const len = s.length
        let sawNewline = false
        while (this.i < len) {
            const code = s.charCodeAt(this.i)
            if (isSpaceCode(code)) {
                if (isLineEnd(code)) {
                    sawNewline = true
                    if (code === CR && s.charCodeAt(this.i + 1) === NL) this.i++
                }
                this.i++
                continue
            }
            if (code === HASH) {
                // Line comment (covers `##` too) — consume to end of line.
                this.i++
                while (this.i < len && !isLineEnd(s.charCodeAt(this.i))) this.i++
                continue
            }
            this.skippedNewline = sawNewline
            return
        }
        this.skippedNewline = sawNewline
    }

    private tok(kind: TokKind, start: number, extra?: Partial<Token>): Token {
        const leadingNewline = this.skippedNewline
        this.skippedNewline = false
        return { kind, text: this.src.slice(start, this.i), start, end: this.i, leadingNewline, ...extra }
    }

    /** Throw a structured parse error (same shape as the parser's) so callers —
     *  and the fuzz harness — see a single "Parse error: …" surface. */
    private lexFail(msg: string, offset: number): never {
        const { line, column } = lineColumn(this.src, offset)
        throw new Error(`Parse error: Line ${line}, col ${column}: ${msg}`)
    }

    private next(): Token {
        this.skipTrivia()
        const s = this.src
        const len = s.length
        const start = this.i
        if (start >= len) {
            const leadingNewline = this.skippedNewline
            this.skippedNewline = false
            return { kind: 'eof', text: '', start, end: start, leadingNewline }
        }
        const c = s[this.i]

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

        // @keyword (defKw / keyword / @true / @false).
        if (c === '@') {
            this.i++
            while (this.i < len && IDENT_TAIL[s.charCodeAt(this.i)] === 1) this.i++
            return this.tok('kw', start)
        }

        if (c === '&') { this.i++; return this.tok('amp', start) }

        // ':' → '::' (nsSep) or ':=' (bind).
        if (c === ':') {
            if (s[this.i + 1] === ':') { this.i += 2; return this.tok('nsSep', start, { sep: '::' }) }
            if (s[this.i + 1] === '=') { this.i += 2; return this.tok('bind', start) }
            this.i++; return this.tok('op', start)        // bare ':' (invalid) → 1-char op
        }

        // '..' half-open range operator (ADR 0016).  Emitted as a 2-char `op`
        // token so the binary-op chain parses `a..b` as BinaryOp('..'); the
        // `@loop` desugar consumes it (ranges are syntactic-only inside @loop).
        // Must precede the single-'.' nsSep rule.  A third '.' falls through to
        // nsSep, so `1...5` lexes as int op('..') nsSep('.') int — a parse error.
        if (c === '.' && s[this.i + 1] === '.') { this.i += 2; return this.tok('op', start) }

        // '.' namespace separator (numbers consume their own '.').
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
            while (this.i < len) {
                const k = s.charCodeAt(this.i)
                if (k === QUOTE || k === BACKSLASH || isLineEnd(k)) break
                this.i++
            }
            if (s[this.i] !== "'") this.lexFail('unterminated string', start)
            this.i++
            return this.tok('string', start)
        }

        // Numbers.
        if (isDigit(c)) return this.lexNumber(start)

        // Operator run (maximal munch).
        const code = s.charCodeAt(this.i)
        if (code < 128 && OP_GLYPH[code] === 1) {
            this.i++
            while (this.i < len && OP_GLYPH[s.charCodeAt(this.i)] === 1) this.i++
            return this.tok('op', start)
        }

        // Identifier.
        if (isIdentStart(c)) {
            this.i++
            while (this.i < len && IDENT_TAIL[s.charCodeAt(this.i)] === 1) this.i++
            return this.tok('ident', start)
        }

        this.lexFail(`unexpected character ${JSON.stringify(c)}`, start)
    }

    private lexNumber(start: number): Token {
        const s = this.src
        const len = s.length
        // Prefixed non-decimal bases: 0x / 0b / 0o (case-insensitive prefix).
        // `this.i` is at the leading '0'.  Underscores may separate digits.
        if (s.charCodeAt(this.i) === 48 /* '0' */ && this.i + 1 < len) {
            const p = s.charCodeAt(this.i + 1)
            const isHex = (k: number) => DIGIT[k] === 1 || (k >= 65 && k <= 70) || (k >= 97 && k <= 102)
            const isBin = (k: number) => k === 48 || k === 49
            const isOct = (k: number) => k >= 48 && k <= 55
            const scanBase = (ok: (k: number) => boolean, base: 'hexadecimal' | 'binary' | 'octal'): Token => {
                this.i += 2  // skip the 0x / 0b / 0o prefix
                const digitsStart = this.i
                while (this.i < len && (ok(s.charCodeAt(this.i))
                    || (s.charCodeAt(this.i) === 95 /* _ */ && this.i + 1 < len && ok(s.charCodeAt(this.i + 1))))) this.i++
                if (this.i === digitsStart) this.lexFail(`${base} literal needs at least one digit`, start)
                return this.tok('int', start, { base })
            }
            if (p === 120 || p === 88) return scanBase(isHex, 'hexadecimal')  // x / X
            if (p === 98  || p === 66) return scanBase(isBin, 'binary')       // b / B
            if (p === 111 || p === 79) return scanBase(isOct, 'octal')        // o / O
        }
        // Decimal (or float): a `.digits` fractional part makes it a float
        // (frac is `digit+`, no underscores).
        const moreDigits = (i: number) => i < len && DIGIT[s.charCodeAt(i)] === 1
        while (this.i < len && (DIGIT[s.charCodeAt(this.i)] === 1
            || (s.charCodeAt(this.i) === 95 /* _ */ && moreDigits(this.i + 1)))) this.i++
        if (s[this.i] === '.' && moreDigits(this.i + 1)) {
            this.i++ // dot
            // Fractional digits may also use `_` as a separator (between digits),
            // matching the integer part: `123_456.789_012`.
            while (this.i < len && (DIGIT[s.charCodeAt(this.i)] === 1
                || (s.charCodeAt(this.i) === 95 /* _ */ && moreDigits(this.i + 1)))) this.i++
            return this.tok('float', start)
        }
        return this.tok('int', start, { base: 'decimal' })
    }
}

/** Convenience: tokenize a source string. */
export function tokenize(src: string): Token[] {
    return new Lexer(src).tokenize()
}

/** Offsets where each line begins (line k starts at lineStarts[k-1]); built once
 *  per source in O(n) so position lookups are O(log n) instead of O(offset). */
export function computeLineStarts(src: string): number[] {
    const starts = [0]
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === NL) starts.push(i + 1)
    return starts
}

/** 1-based line/column for an offset, using precomputed line starts. Matches
 *  ohm's getLineAndColumn: line increments on '\n'; '\r' doesn't advance the
 *  column. Binary-search for the line, then count non-'\r' chars on it. */
export function lineColumnAt(lineStarts: number[], src: string, offset: number): { line: number; column: number } {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (lineStarts[mid] <= offset) lo = mid
        else hi = mid - 1
    }
    const lineStart = lineStarts[lo]
    const end = Math.min(offset, src.length)
    let column = 1
    for (let i = lineStart; i < end; i++) if (src.charCodeAt(i) !== CR) column++
    return { line: lo + 1, column }
}

/** 1-based line/column for a char offset (standalone; builds line starts each
 *  call — for one-off external use). The parser uses lineColumnAt with cached
 *  line starts. */
export function lineColumn(src: string, offset: number): { line: number; column: number } {
    return lineColumnAt(computeLineStarts(src), src, offset)
}
