// SPDX-License-Identifier: MIT
/**
 * Hand-written recursive-descent LL(1) parser for Silicon — zero dependencies.
 *
 * Produces the SAME AST the ohm path produces (addToAstSemantics(...).toAst()),
 * node-for-node, by reusing the shared `ASTFactory` and reproducing toAst's
 * exact return values. It does NOT mimic ohm's PEG backtracking — it follows
 * the LL(1) shape documented in docs/grammar.ebnf (the left-factored appendix),
 * with one token of lookahead. Maximal-munch tokenization (lexer.ts) makes the
 * two ambiguous spots decidable:
 *   - `=` (assignment) vs operator runs like `==`  → a lone `=` op token.
 *   - `&@as` (ascription) vs `&@assert` (keyword call) → peek the keyword token.
 *
 * The ohm grammar (src/grammar/silicon-official.ohm) is the current source of
 * truth for productions (docs/grammar.ebnf predates the signature-lines
 * migration); this parser matches it and is verified node-equal against it
 * over the corpus in handwritten.equivalence.test.ts.
 */

import {
    ASTFactory,
    type Program, type Definition, type Namespace, type TypeAnnotation,
    type TypedIdentifier, type Parameter, type GenericParams, type Binding,
    type ExpressionStart, type SourceLocation, type ASTNode,
} from '../../ast/astNodes'
import { Lexer, lineColumn, type Token } from './lexer'

/** Internal shape produced by AttachedSig (mirrors toAst's anonymous object). */
interface SigInfo { name: string; generics?: GenericParams; type: any }

/**
 * Reproduce toAst's decLiteral value reconstruction, including its quirk: ohm's
 * iteration `.sourceString` makes both columns of `("_" digit+)*` span the whole
 * group, so the separator-onward tail is duplicated — `value = text +
 * text.slice(firstUnderscore)`. e.g. `1_000` → `"1_000_000"`, `1_000_000` →
 * `"1_000_000_000_000"`. We match it exactly for byte-identical ASTs.
 */
function ohmDecValue(text: string): string {
    const first = text.indexOf('_')
    return first < 0 ? text : text + text.slice(first)
}

/** Float = INT "." FRAC; only the integer part carries `_` separators. */
function ohmFloatValue(text: string): string {
    const dot = text.indexOf('.')
    return ohmDecValue(text.slice(0, dot)) + '.' + text.slice(dot + 1)
}

class Parser {
    private readonly toks: Token[]
    private pos = 0

    constructor(private readonly src: string) {
        this.toks = new Lexer(src).tokenize()
    }

    // ── token cursor ────────────────────────────────────────────────────────
    private peek(ahead = 0): Token { return this.toks[Math.min(this.pos + ahead, this.toks.length - 1)] }
    private next(): Token { return this.toks[this.pos++] }
    private at(kind: Token['kind']): boolean { return this.peek().kind === kind }
    private atEof(): boolean { return this.at('eof') }
    private expect(kind: Token['kind']): Token {
        const t = this.peek()
        if (t.kind !== kind) this.fail(`expected ${kind} but found ${t.kind} '${t.text}'`, t)
        return this.next()
    }
    private fail(msg: string, t = this.peek()): never {
        const { line, column } = lineColumn(this.src, t.start)
        throw new Error(`Parse error: ${msg} (line ${line}, col ${column})`)
    }

    private loc(start: number, end: number): SourceLocation {
        const a = lineColumn(this.src, start)
        const b = lineColumn(this.src, end)
        return { startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column }
    }

    // ── Program / Element ─────────────────────────────────────────────────────
    parseProgram(): Program {
        const elements: any[] = []
        while (!this.atEof()) {
            const r = this.parseElement()
            if (Array.isArray(r)) elements.push(...r)
            else elements.push(r)
        }
        return ASTFactory.program(elements)
    }

    // Element = BlockDef | Item ";" | (DocComment — dead: '##' is a comment)
    private parseElement(): ASTNode | Definition[] {
        const t = this.peek()
        // Definition with an attached signature: `\\ sig` then `@kw …;`
        if (t.kind === 'attachedSig') {
            const def = this.parseDefinitionWithSig()
            this.expect('semi')
            return def
        }
        if (this.isDefKw(t)) {
            const r = this.parseDefOrBlockDef()
            if (Array.isArray(r)) return r          // BlockDef — no trailing ';'
            this.expect('semi')
            return r
        }
        const item = this.parseItem()
        this.expect('semi')
        return item
    }

    /** A defKw is an `@ident` keyword that is not the reserved `@true`/`@false`. */
    private isDefKw(t: Token): boolean {
        return t.kind === 'kw' && t.text !== '@true' && t.text !== '@false'
    }

    // ── Definitions ───────────────────────────────────────────────────────────
    // Shared prefix `defKw identifier? generics?` then either a SignatureBlock
    // (BlockDef) or Params+Binding (Definition).
    private parseDefOrBlockDef(): Definition | Definition[] {
        const kw = this.next().text                     // defKw, includes '@'
        const identTok = this.at('ident') ? this.next() : undefined
        const generics = this.at('lbrack') ? this.parseGenericParams() : undefined

        if (this.at('lbrace')) {
            const sigs = this.parseSignatureBlock()
            return this.buildBlockDef(kw, generics, sigs)
        }

        if (!identTok) this.fail('definition requires a name')
        const params = this.parseParams()
        const binding = this.at('bind') ? this.parseBinding() : undefined
        return this.buildDefinition(undefined, kw, identTok, generics, params, binding)
    }

    // Definition = AttachedSig defKw identifier generics? Params Binding?
    private parseDefinitionWithSig(): Definition {
        const sig = this.parseAttachedSig()
        const kwTok = this.peek()
        if (!this.isDefKw(kwTok)) this.fail('expected a definition keyword after signature')
        const kw = this.next().text
        const identTok = this.expect('ident')
        const generics = this.at('lbrack') ? this.parseGenericParams() : undefined
        const params = this.parseParams()
        const binding = this.at('bind') ? this.parseBinding() : undefined
        return this.buildDefinition(sig, kw, identTok, generics, params, binding)
    }

    // AttachedSig = "\\" namespace generics? TypeExpr
    private parseAttachedSig(): SigInfo {
        this.expect('attachedSig')
        const nsStart = this.peek().start
        const nsEnd = this.parseNamespaceRawEnd()       // consumes the namespace; returns end offset
        const name = this.src.slice(nsStart, nsEnd)     // raw text (keeps '::')
        const generics = this.at('lbrack') ? this.parseGenericParams() : undefined
        const type = this.parseTypeExpr()
        return { name, generics, type }
    }

    // BlockDef → Definition[].  @interface = stub (no defs); @extern expands each sig.
    private buildBlockDef(kw: string, _generics: GenericParams | undefined, sigs: SigInfo[]): Definition[] {
        if (kw === '@interface') return []
        return sigs.map((sig) => {
            const fnType = sig.type
            const slots = Array.isArray(fnType?.fnParams)
                ? fnType.fnParams
                : (fnType?.__domain ? fnType.types.map((t: any) => ({ typeAnnotation: t })) : [])
            const params = slots.map((slot: any, i: number) =>
                ASTFactory.parameter('_arg' + i, slot.typeAnnotation))
            let ret = fnType?.fnReturn?.typeAnnotation
            if (ret?.typename === 'Void') ret = undefined
            const name = ASTFactory.typedIdentifier(sig.name, ret)
            return ASTFactory.definition(kw, name, params, sig.generics, undefined)
        })
    }

    // Distribute an attached signature's domain/range onto bare params + return,
    // exactly as toAst's Definition action does.
    private buildDefinition(
        sig: SigInfo | undefined, kw: string, identTok: Token,
        generics: GenericParams | undefined, paramListIn: Parameter[], binding: Binding | undefined,
    ): Definition {
        let genericParams = generics
        let paramList = paramListIn
        let returnAnnotation: TypeAnnotation | undefined

        if (sig) {
            const fnType = sig.type
            if (fnType && Array.isArray(fnType.fnParams)) {
                paramList = paramList.map((p, i) => {
                    const slot = fnType.fnParams[i]
                    return slot
                        ? ASTFactory.parameter(p.name, slot.typeAnnotation, p.isLiteral, p.value)
                        : p
                })
                returnAnnotation = fnType.fnReturn?.typeAnnotation
            } else if (fnType && fnType.__domain) {
                paramList = paramList.map((p, i) => {
                    const t = fnType.types[i]
                    return t ? ASTFactory.parameter(p.name, t, p.isLiteral, p.value) : p
                })
                returnAnnotation = undefined
            } else if (fnType) {
                returnAnnotation = fnType
            }
            if (returnAnnotation?.typename === 'Void') returnAnnotation = undefined
            if (sig.generics) genericParams = sig.generics
        }

        const name = ASTFactory.typedIdentifier(identTok.text, returnAnnotation)
        const node = ASTFactory.definition(kw, name, paramList, genericParams, binding)
        node.sourceLocation = this.loc(identTok.start, identTok.end)
        return node
    }

    private parseSignatureBlock(): SigInfo[] {
        this.expect('lbrace')
        const sigs: SigInfo[] = []
        while (this.at('attachedSig')) sigs.push(this.parseAttachedSig())
        this.expect('rbrace')
        return sigs
    }

    private parseBinding(): Binding {
        this.expect('bind')
        return ASTFactory.binding(this.parseExpressionStart())
    }

    private parseGenericParams(): GenericParams {
        this.expect('lbrack')
        const params: string[] = [this.expect('ident').text]
        while (this.at('comma')) { this.next(); params.push(this.expect('ident').text) }
        this.expect('rbrack')
        return ASTFactory.genericParams(params)
    }

    // Params = ListOf<ParamLiteral, ",">  (bare; possibly empty)
    private parseParams(): Parameter[] {
        const params: Parameter[] = []
        if (!this.startsParamLiteral(this.peek())) return params
        params.push(this.parseParamLiteral())
        while (this.at('comma') && this.startsParamLiteral(this.peek(1))) {
            this.next()
            params.push(this.parseParamLiteral())
        }
        return params
    }

    private startsParamLiteral(t: Token): boolean {
        if (t.kind === 'ident') return true
        return this.startsLiteral(t)
    }

    // ParamLiteral = identifier TypeExpr? | Literal
    private parseParamLiteral(): Parameter {
        if (this.at('ident')) {
            const name = this.next().text
            const typeAnnotation = this.startsTypeExpr(this.peek()) ? this.parseTypeExpr() : undefined
            return ASTFactory.parameter(name, typeAnnotation)
        }
        const lit = this.parseLiteral()
        return ASTFactory.parameter('_param', undefined, true, lit)
    }

    // ── Items / expressions ───────────────────────────────────────────────────
    // Item (non-BlockDef) = Definition | Assignment | ExpressionStart.
    // (Definitions are handled by the caller for top-level; blocks call this.)
    private parseItem(): ASTNode {
        const t = this.peek()
        if (t.kind === 'attachedSig') return this.parseDefinitionWithSig()
        if (this.isDefKw(t)) {
            const r = this.parseDefOrBlockDef()
            // A BlockDef cannot appear as a block Item in valid programs; only a
            // Definition reaches here in practice.
            if (Array.isArray(r)) this.fail('signature block not allowed here', t)
            return r as Definition
        }
        if (t.kind === 'ident') {
            const ns = this.parseNamespace()
            if (this.at('op') && this.peek().text === '=') {
                this.next()
                return ASTFactory.assignment(ns, this.parseExpressionStart() as ExpressionStart)
            }
            return this.parseBinOpChain(ns)
        }
        return this.parseExpressionStart()
    }

    // ExpressionStart = ExpressionEnd (BinOp ExpressionEnd)*
    private parseExpressionStart(): ASTNode {
        return this.parseBinOpChain(this.parseExpressionEnd())
    }

    private parseBinOpChain(left: ASTNode): ASTNode {
        let result = left
        while (this.at('op')) {
            const operator = this.next().text
            const right = this.parseExpressionEnd()
            result = ASTFactory.binOp(result as ExpressionStart, operator, right as any)
        }
        return result
    }

    // ExpressionEnd = Literal | AscribeExpr | FunctionCall | VariantDecl
    //               | namespace | Block | "(" ExpressionStart ")"
    private parseExpressionEnd(): ASTNode {
        const t = this.peek()
        switch (t.kind) {
            case 'string': case 'int': case 'float': case 'arrOpen': case 'objOpen': case 'tupOpen':
                return this.parseLiteral()
            case 'kw':
                if (t.text === '@true' || t.text === '@false') return this.parseLiteral()
                this.fail(`unexpected keyword '${t.text}' in expression`, t)
            // eslint-disable-next-line no-fallthrough
            case 'amp':
                return this.parseAmp()
            case 'dollar':
                return this.parseVariantDecl()
            case 'ident':
                return this.parseNamespace()
            case 'lbrace':
                return this.parseBlock()
            case 'lparen': {
                this.next()
                const inner = this.parseExpressionStart()
                this.expect('rparen')
                return inner
            }
            default:
                this.fail(`unexpected ${t.kind} '${t.text}' in expression`, t)
        }
    }

    // '&' → AscribeExpr ("&@as" …) | FunctionCall
    private parseAmp(): ASTNode {
        this.expect('amp')
        const head = this.peek()
        if (head.kind === 'kw' && head.text === '@as') {
            this.next()                                   // '@as'
            const typeExpr = this.parseTypeExpr()
            this.expect('comma')
            const expr = this.parseExpressionStart()
            return ASTFactory.ascription(expr, typeExpr)
        }
        if (head.kind === 'kw') {
            const name = this.next().text                 // keyword incl '@'
            const args = this.parseCallArgs()
            return ASTFactory.functionCall(name, true, args as ExpressionStart[])
        }
        if (head.kind === 'ident') {
            const ns = this.parseNamespace()
            const args = this.parseCallArgs()
            return ASTFactory.functionCall(ns, false, args as ExpressionStart[])
        }
        this.fail(`expected a keyword or name after '&'`, head)
    }

    // CallArgsOrEnd = CallArgs | CallNoArgs.  Args present iff the next token can
    // begin an expression (argStart); empty iff it's a call terminator.
    private parseCallArgs(): ASTNode[] {
        if (this.startsArg(this.peek())) {
            const args = [this.parseExpressionStart()]
            while (this.at('comma')) { this.next(); args.push(this.parseExpressionStart()) }
            return args
        }
        const t = this.peek()
        if (t.kind === 'semi' || t.kind === 'rparen' || t.kind === 'rbrace'
            || t.kind === 'comma' || t.kind === 'eof') return []
        this.fail(`unexpected ${t.kind} '${t.text}' after call`, t)
    }

    // argStart = digit | "'" | "$" | "@" | "{" | "(" | "&" | letter | "_"
    private startsArg(t: Token): boolean {
        switch (t.kind) {
            case 'int': case 'float': case 'string': case 'kw':
            case 'dollar': case 'arrOpen': case 'objOpen': case 'tupOpen':
            case 'lbrace': case 'lparen': case 'amp': case 'ident':
                return true
            default:
                return false
        }
    }

    // VariantDecl = "$" identifier ListOf<ParamLiteral, ",">
    private parseVariantDecl(): ASTNode {
        this.expect('dollar')
        const name = this.expect('ident').text
        const fields: TypedIdentifier[] = []
        if (this.startsParamLiteral(this.peek())) {
            fields.push(this.variantField())
            while (this.at('comma') && this.startsParamLiteral(this.peek(1))) {
                this.next()
                fields.push(this.variantField())
            }
        }
        return ASTFactory.variantDecl(name, fields)
    }

    // Variant fields reuse ParamLiteral, but VariantDecl's AST stores
    // TypedIdentifier[] (it maps each ParamLiteral via toAst → parameter, which
    // the variantDecl factory keeps as-is). toAst stores the Parameter objects
    // directly in `fields`, so mirror that.
    private variantField(): any {
        return this.parseParamLiteral()
    }

    // ── Namespace ─────────────────────────────────────────────────────────────
    // namespace = identifier (("::" | ".") identifier)*
    private parseNamespace(): Namespace {
        const startTok = this.expect('ident')
        const parts = [startTok.text]
        let endOff = startTok.end
        while (this.at('nsSep')) {
            this.next()
            const id = this.expect('ident')
            parts.push(id.text)
            endOff = id.end
        }
        const node = ASTFactory.namespace(parts)
        node.sourceLocation = this.loc(startTok.start, endOff)
        return node
    }

    /** Consume a namespace for AttachedSig; return the end offset of the last part. */
    private parseNamespaceRawEnd(): number {
        let endOff = this.expect('ident').end
        while (this.at('nsSep')) { this.next(); endOff = this.expect('ident').end }
        return endOff
    }

    // ── Block ─────────────────────────────────────────────────────────────────
    // Block = "{" { Item ";" } [ ExpressionStart ] "}"  (left-factored)
    private parseBlock(): ASTNode {
        this.expect('lbrace')
        const items: any[] = []
        let trailing: any
        while (!this.at('rbrace')) {
            const node = this.parseItem()
            if (this.at('semi')) { this.next(); items.push(node) }
            else { trailing = node; break }
        }
        this.expect('rbrace')
        return ASTFactory.block(items, trailing)
    }

    // ── Literals ──────────────────────────────────────────────────────────────
    private startsLiteral(t: Token): boolean {
        switch (t.kind) {
            case 'string': case 'int': case 'float':
            case 'arrOpen': case 'objOpen': case 'tupOpen':
                return true
            case 'kw':
                return t.text === '@true' || t.text === '@false'
            default:
                return false
        }
    }

    private parseLiteral(): any {
        const t = this.peek()
        switch (t.kind) {
            case 'string': { this.next(); return ASTFactory.stringLiteral(this.src.slice(t.start + 1, t.end - 1)) }
            case 'int': { this.next(); return ASTFactory.intLiteral(ohmDecValue(t.text), t.base!) }
            case 'float': { this.next(); return ASTFactory.floatLiteral(ohmFloatValue(t.text)) }
            case 'kw': { this.next(); return ASTFactory.booleanLiteral(t.text === '@true') }
            case 'arrOpen': return this.parseArrayLiteral()
            case 'objOpen': return this.parseObjectLiteral()
            case 'tupOpen': return this.parseTupleLiteral()
            default: this.fail(`expected a literal but found ${t.kind} '${t.text}'`, t)
        }
    }

    private parseArrayLiteral(): any {
        this.expect('arrOpen')
        const elements = this.exprListUntil('rbrack')
        this.expect('rbrack')
        return ASTFactory.arrayLiteral(elements as ExpressionStart[])
    }

    private parseTupleLiteral(): any {
        this.expect('tupOpen')
        const elements = this.exprListUntil('rparen')
        this.expect('rparen')
        return ASTFactory.tupleLiteral(elements as ExpressionStart[])
    }

    private parseObjectLiteral(): any {
        this.expect('objOpen')
        const pairs: any[] = []
        if (!this.at('rbrace')) {
            pairs.push(this.parseKeyValuePair())
            while (this.at('comma')) { this.next(); pairs.push(this.parseKeyValuePair()) }
        }
        this.expect('rbrace')
        return ASTFactory.objectLiteral(pairs)
    }

    private parseKeyValuePair(): any {
        const key = ASTFactory.typedIdentifier(this.expect('ident').text)
        if (!(this.at('op') && this.peek().text === '=')) this.fail("expected '=' in key/value pair")
        this.next()
        return ASTFactory.keyValuePair(key, this.parseExpressionStart() as ExpressionStart)
    }

    /** Comma-separated ExpressionStart list, possibly empty, up to `close`. */
    private exprListUntil(close: Token['kind']): ASTNode[] {
        const out: ASTNode[] = []
        if (this.at(close)) return out
        out.push(this.parseExpressionStart())
        while (this.at('comma')) { this.next(); out.push(this.parseExpressionStart()) }
        return out
    }

    // ── Types ─────────────────────────────────────────────────────────────────
    private startsTypeExpr(t: Token): boolean {
        return t.kind === 'ident' || t.kind === 'lparen'
    }

    // TypeExpr = TypeAtom TypeArrow?
    private parseTypeExpr(): any {
        const atom = this.parseTypeAtom()
        if (!(this.at('op') && this.peek().text === '->')) {
            return atom                       // bare atom or { __domain } group
        }
        this.next()                            // '->'
        const range = this.parseTypeExpr() as TypeAnnotation
        const isGroup = atom && atom.__domain === true
        const domain: TypeAnnotation[] = isGroup ? atom.types : [atom]
        const fnReturn = ASTFactory.typedIdentifier('_', range)
        const fnParams = domain.map((t) => ASTFactory.typedIdentifier('_', t))
        const ann = ASTFactory.fnTypeAnnotation(fnReturn, fnParams)
        ann.typename = '$fn'
        return ann
    }

    // TypeAtom = identifier typeArgs? | "(" ListOf<TypeExpr, ","> ")"
    private parseTypeAtom(): any {
        if (this.at('lparen')) {
            this.next()
            const types: any[] = []
            if (!this.at('rparen')) {
                types.push(this.parseTypeExpr())
                while (this.at('comma')) { this.next(); types.push(this.parseTypeExpr()) }
            }
            this.expect('rparen')
            return { __domain: true, types }
        }
        const name = this.expect('ident').text
        const typeArgs = this.at('lbrack') ? this.parseTypeArgs() : undefined
        return ASTFactory.typeAnnotation(name, typeArgs)
    }

    // typeArgs = "[" typeArg ("," typeArg)* "]"
    private parseTypeArgs(): any[] {
        this.expect('lbrack')
        const items: any[] = [this.parseTypeArg()]
        while (this.at('comma')) { this.next(); items.push(this.parseTypeArg()) }
        this.expect('rbrack')
        return items
    }

    // typeArg = identifier typeArgs?  → { type:'TypeArg', name, args }
    private parseTypeArg(): any {
        const name = this.expect('ident').text
        const args = this.at('lbrack') ? this.parseTypeArgs() : undefined
        return { type: 'TypeArg', name, args }
    }
}

/** Parse Silicon source into the AST (identical to the ohm path's toAst). */
export function parseToAst(sourceCode: string): Program {
    return new Parser(sourceCode).parseProgram()
}

export default parseToAst
