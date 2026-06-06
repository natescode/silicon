// SPDX-License-Identifier: MIT
/**
 * ADR 0020 codemod — migrate Silicon source from the current grammar to the
 * Odin-inspired grammar (bare definitions, always-parens calls, drop `&`,
 * `@mut`/`@type` markers). See docs/adr/0020-odin-inspired-grammar.md.
 *
 * STRATEGY: parse with the production parser, then RE-EMIT in ADR 0020 syntax.
 * The transformation is a fork of compiler/src/fmt/formatter.ts with three rules:
 *
 *   1. emitDefinition  — drop @fn/@global (bare); @local/@var -> `@mut`;
 *                        @struct -> `@type Name := { fields }`; keep @type. Types
 *                        are space-separated; function types are reconstructed onto
 *                        a `\\` signature line (no inline return-type syntax).
 *   2. emitCall        — `&name a, b`  ->  `name(a, b)`  (drop &, add parens).
 *                        Uniform for user calls AND `&@if`/`&@loop`/`&@match`.
 *   3. emitBinOp       — drop the call-operand paren reconstruction (always-parens
 *                        makes `f(x) + y` unambiguous); keep the no-precedence
 *                        grouping parens on a BinaryOp right operand.
 *
 * COMMENT PRESERVATION: comments are lexer-stripped (never reach the AST), so they
 * are scanned from source and re-interleaved by position. Every AST node carries
 * `sourceLocation` (absolute line/col), so before emitting each element/block-item
 * we flush the source comments / blank lines / `@use` lines that precede it, and a
 * trailing inline comment is re-attached to the line it sat on. Result: comments,
 * blank-line structure, and `@use` lines are preserved in source order.
 * (Limitation: a comment buried inside a single multi-line *non-block* expression,
 * or directly before a block's closing `}`, may shift to the next statement
 * boundary — preserved, lightly repositioned. `.` paths normalise to `::`.)
 *
 * USAGE (non-destructive by default — writes a copy under build/adr0020/):
 *   bun run tools/migrate-adr0020.ts                  # whole stdlib -> build/adr0020/
 *   bun run tools/migrate-adr0020.ts --check          # parse + report only, write nothing
 *   bun run tools/migrate-adr0020.ts --stdout f.si    # print one file's migration
 *   bun run tools/migrate-adr0020.ts --out dir a.si   # e.g. --out compiler/src/stdlib (in place)
 */

import { parseToAst } from '../compiler/src/parser/handwritten/parser'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

const IND = '    '
const ind = (d: number) => IND.repeat(d)

interface Report { file: string; out: string; elements: number; comments: number; flags: string[] }
const FLAGS: string[] = [] // current-file flag sink

// ---------------------------------------------------------------------------
// Preserved non-AST lines — comments, `@use`, and blanks, in source order.
// These are interleaved into the output by source line number (the AST drops
// them all). `flushBefore`/`trailingAt` consume them as the emitter walks nodes.
// ---------------------------------------------------------------------------

interface Pres { line: number; text: string; ownLine: boolean; kind: 'use' | 'comment' | 'blank' }
let PRES: Pres[] = []
let PCUR = 0

function scanPreserved(src: string): Pres[] {
    const out: Pres[] = []
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const ln = i + 1
        if (line.trim() === '') { out.push({ line: ln, text: '', ownLine: true, kind: 'blank' }); continue }
        if (/^\s*@use\b/.test(line)) {
            out.push({ line: ln, text: line.trim().replace(/;?\s*$/, ';'), ownLine: true, kind: 'use' })
            continue
        }
        // first '#' not inside a single-quote string (Silicon strings have no escapes)
        let inStr = false, idx = -1
        for (let j = 0; j < line.length; j++) {
            const c = line[j]
            if (c === "'") inStr = !inStr
            else if (c === '#' && !inStr) { idx = j; break }
        }
        if (idx >= 0) {
            out.push({ line: ln, text: line.slice(idx).trimEnd(), ownLine: line.slice(0, idx).trim() === '', kind: 'comment' })
        }
    }
    return out
}

// Emit every preserved line whose source line is strictly before `line`.
function flushBefore(line: number, depth: number, acc: string[]): void {
    while (PCUR < PRES.length && PRES[PCUR].line < line) {
        const p = PRES[PCUR++]
        acc.push(p.kind === 'blank' ? '' : ind(depth) + p.text)
    }
}

// A trailing inline comment sitting on exactly `line` — consume and return it.
function trailingAt(line: number): string {
    const p = PRES[PCUR]
    if (p && p.line === line && p.kind === 'comment' && !p.ownLine) { PCUR++; return '  ' + p.text }
    return ''
}

// Statement-level nodes (FunctionCall, Namespace, …) don't all carry their own
// sourceLocation, but some descendant always does — so take the min start / max
// end line over the whole subtree.
function nodeStart(node: any): number {
    let min = Infinity
    const visit = (x: any) => {
        if (!x || typeof x !== 'object') return
        if (Array.isArray(x)) { x.forEach(visit); return }
        if (x.sourceLocation?.startLine != null) min = Math.min(min, x.sourceLocation.startLine)
        for (const k in x) if (k !== 'sourceLocation' && k !== 'relSpan') visit(x[k])
    }
    visit(node)
    return min
}
function nodeEnd(node: any): number {
    let max = -Infinity
    const visit = (x: any) => {
        if (!x || typeof x !== 'object') return
        if (Array.isArray(x)) { x.forEach(visit); return }
        if (x.sourceLocation?.endLine != null) max = Math.max(max, x.sourceLocation.endLine)
        for (const k in x) if (k !== 'sourceLocation' && k !== 'relSpan') visit(x[k])
    }
    visit(node)
    return max
}

// ---------------------------------------------------------------------------
// Emitter (forked from compiler/src/fmt/formatter.ts — ADR 0020 rules)
// ---------------------------------------------------------------------------

function emitProgram(program: any): string {
    const parts: string[] = []
    for (const el of program.elements) {
        const sl = nodeStart(el); if (sl !== Infinity) flushBefore(sl, 0, parts)
        parts.push(ind(0) + emit(el, 0) + ';' + trailingAt(nodeEnd(el)))
    }
    flushBefore(Infinity, 0, parts) // any trailing end-of-file comments
    while (parts.length && parts[parts.length - 1] === '') parts.pop()
    return parts.join('\n') + '\n'
}

function emit(node: any, depth: number): string {
    if (!node) return ''
    switch (node.type) {
        case 'Assignment':     return emitNamespace(node.target) + ' = ' + emit(node.value, depth)
        case 'Definition':     return emitDefinition(node, depth)
        case 'BinaryOp':       return emitBinOp(node, depth)
        case 'FunctionCall':   return emitCall(node, depth)          // <-- CHANGED
        case 'Block':          return emitBlock(node, depth)
        case 'Namespace':      return emitNamespace(node)
        case 'VariantDecl':    return emitVariantDecl(node)
        case 'StringLiteral':  return "'" + node.value + "'"
        case 'IntLiteral':     return node.value
        case 'FloatLiteral':   return node.value
        case 'BooleanLiteral': return node.value ? '@true' : '@false'
        case 'ArrayLiteral':   return '$[' + node.elements.map((e: any) => emit(e, depth)).join(', ') + ']'
        case 'ObjectLiteral':  return '${' + node.properties.map((kv: any) => emitTypedId(kv.key) + '=' + emit(kv.value, depth)).join(', ') + '}'
        case 'TupleLiteral':   return '$(' + node.elements.map((e: any) => emit(e, depth)).join(', ') + ')'
        // defensive unwrappers
        case 'Literal':        return emit(node.value, depth)
        case 'Binding':        return emit(node.expression, depth)
        case 'ExpressionStart':
        case 'ExpressionEnd':
        case 'Statement':
        case 'Item':           return emit(node.value, depth)
        case 'Element':        return node.kind === 'docComment' ? '##' + node.value.content : emit(node.value, depth)
        default:               return ''
    }
}

// CHANGE 1 — definition keyword mapping (bare = common, @-marker = special).
// Types are SPACE-separated (the parser rejects ':Type' on params/structs/returns).
// Function types are carried on a RECONSTRUCTED `\\` signature line — there is no
// inline return-type syntax, and the parser merges `\\` into the def, so a typed
// function `\\ f (A, B) -> R` + bare-param `f a, b := …` is the canonical form.
function emitDefinition(def: any, depth: number): string {
    const kw: string = def.keyword
    const namePlain: string = def.name.name
    const generics = def.generics && def.generics.params.length > 0
        ? '[' + def.generics.params.join(', ') + ']'
        : ''

    // @struct Name[T] f1 T1, f2 T2  ->  @type Name[T] := { f1 T1, f2 T2 }  (space fields)
    if (kw === '@struct') {
        FLAGS.push(`@struct '${namePlain}' -> @type with struct RHS (verify: type-context struct grammar is unimplemented)`)
        const fields = def.params.map(emitFieldSpace).join(', ')
        return '@type ' + namePlain + generics + ' := { ' + fields + ' }'
    }
    if (kw === '@enum') {
        FLAGS.push(`@enum '${namePlain}' passed through unchanged — needs manual ADR 0020 form`)
    }
    if (kw === '@type') {
        // type definition kept; variant payloads / aliases emit via emit() (space form)
        let out = '@type ' + namePlain + generics
        if (def.binding) out += ' := ' + emit(def.binding.expression, depth)
        return out
    }
    if (kw === '@extern') {
        FLAGS.push(`@extern '${namePlain}' -> should become a '\\\\ @extern' signature-line modifier (manual)`)
    }

    const prefix =
        kw === '@fn'     ? '' :          // bare; function (has params)
        kw === '@global' ? '' :          // bare; immutable module constant
        kw === '@let'    ? '' :          // bare; immutable (legacy)
        kw === '@local'  ? '@mut ' :     // mutable binding
        kw === '@var'    ? '@mut ' :     // mutable (legacy)
        (FLAGS.push(`unmapped definition keyword '${kw}' kept verbatim — review`), kw + ' ')

    // bare def line: names only — NO inline types (they go on the reconstructed \\ line)
    let defLine = prefix + namePlain + generics
    if (def.params.length > 0) {
        defLine += ' ' + def.params.map((p: any) =>
            p.isLiteral && p.value ? emit(p.value, depth) : p.name).join(', ')
    }
    if (def.binding) defLine += ' := ' + emit(def.binding.expression, depth)

    // reconstruct the `\\` signature line from the merged type annotations
    const retType = def.name.typeAnnotation ? typeExprSource(def.name.typeAnnotation) : ''
    const paramTypes = def.params.map((p: any) => p.typeAnnotation ? typeExprSource(p.typeAnnotation) : null)
    const hasTypeInfo = retType !== '' || paramTypes.some((t: any) => t !== null)
    // blocks DO allow `\\` lines (verified), so reconstruct at any depth — the
    // caller indents the first line; we indent the def line ourselves.
    if (hasTypeInfo) {
        let sig: string
        if (def.params.length > 0) {
            sig = '\\\\ ' + namePlain + generics + ' (' + paramTypes.map((t: any) => t ?? '_').join(', ') + ')'
            if (retType) sig += ' -> ' + retType
        } else {
            sig = '\\\\ ' + namePlain + generics + ' ' + (retType || '_')   // typed value
        }
        return sig + '\n' + ind(depth) + defLine
    }
    return defLine
}

// struct field / variant payload — `name Type` (space; the parser's real form)
function emitFieldSpace(p: any): string {
    return p.name + (p.typeAnnotation ? ' ' + typeExprSource(p.typeAnnotation) : '')
}

// CHANGE 2 — calls are always parenthesized; the `&` sigil is gone.
function emitCall(fc: any, depth: number): string {
    const name = typeof fc.name === 'string' ? fc.name : emitNamespace(fc.name)
    return name + '(' + fc.args.map((a: any) => emit(a, depth)).join(', ') + ')'
}

// CHANGE 3 — drop the call-operand paren reconstruction; keep the no-precedence
// grouping parens on a BinaryOp right operand.
function emitBinOp(b: any, depth: number): string {
    const leftStr = emit(b.left, depth)
    const rightStr = b.right.type === 'BinaryOp'
        ? '(' + emit(b.right, depth) + ')'
        : emit(b.right, depth)
    return leftStr + ' ' + b.operator + ' ' + rightStr
}

// Blocks interleave preserved comments/blanks before each item + trailing expr.
function emitBlock(b: any, depth: number): string {
    const inner = depth + 1
    const lines: string[] = ['{']
    for (const item of b.items) {
        const sl = nodeStart(item); if (sl !== Infinity) flushBefore(sl, inner, lines)
        lines.push(ind(inner) + emit(item, inner) + ';' + trailingAt(nodeEnd(item)))
    }
    if (b.trailing) {
        const sl = nodeStart(b.trailing); if (sl !== Infinity) flushBefore(sl, inner, lines)
        lines.push(ind(inner) + emit(b.trailing, inner) + trailingAt(nodeEnd(b.trailing)))
    }
    if (lines.length === 1) return '{}' // nothing inside (no items, trailing, or comments)
    lines.push(ind(depth) + '}')
    return lines.join('\n')
}

function emitNamespace(ns: any): string { return ns.path.join('::') }

// space-separated typed identifier (object-literal keys etc.)
function emitTypedId(ti: any): string {
    return ti.name + (ti.typeAnnotation ? ' ' + typeExprSource(ti.typeAnnotation) : '')
}

// a type rendered as Silicon source: `Int`, `Option[T]`, or a function type
// `(A, B) -> C`. No leading ':' — Silicon type syntax is positional/space-based.
function typeExprSource(ta: any): string {
    if (!ta) return ''
    if (ta.typename === '$fn') {
        const ps = (ta.fnParams || []).map((p: any) => typeExprSource(p.typeAnnotation)).join(', ')
        const ret = ta.fnReturn ? typeExprSource(ta.fnReturn.typeAnnotation) : ''
        return '(' + ps + ')' + (ret ? ' -> ' + ret : '')
    }
    let out = ta.typename
    if (ta.typeArgs && ta.typeArgs.length > 0) out += '[' + ta.typeArgs.map(emitTypeArg).join(', ') + ']'
    return out
}

function emitTypeArg(ta: any): string {
    let out = ta.name
    if (ta.args && ta.args.length > 0) out += '[' + ta.args.map(emitTypeArg).join(', ') + ']'
    return out
}

function emitVariantDecl(vd: any): string {
    return '$' + vd.name + (vd.fields.length > 0 ? ' ' + vd.fields.map(emitFieldSpace).join(', ') : '')
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function migrateFile(path: string): { text: string; report: Report } {
    FLAGS.length = 0
    const original = readFileSync(path, 'utf8')
    // `@use '...';` is resolved by preprocessing, not the grammar — blank the lines
    // for parsing (preserving line numbers so sourceLocation stays aligned), but
    // keep them (and all comments + blanks) in the preserved stream for re-emission.
    const stripped = original.split('\n').map(l => (/^\s*@use\b/.test(l) ? '' : l)).join('\n')
    PRES = scanPreserved(original)
    PCUR = 0
    const ast = parseToAst(stripped)
    const text = emitProgram(ast)
    return {
        text,
        report: {
            file: path,
            out: '',
            elements: ast.elements.length,
            comments: PRES.filter(p => p.kind === 'comment').length,
            flags: [...new Set(FLAGS)],
        },
    }
}

function defaultStdlib(): string[] {
    const root = 'compiler/src/stdlib'
    const out: string[] = []
    const walk = (dir: string) => {
        for (const e of readdirSync(dir)) {
            const p = join(dir, e)
            if (statSync(p).isDirectory()) walk(p)
            else if (p.endsWith('.si')) out.push(p)
        }
    }
    walk(root)
    return out.sort()
}

function main() {
    const argv = process.argv.slice(2)
    let outDir = 'build/adr0020'
    let check = false
    let toStdout = false
    const files: string[] = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--check') check = true
        else if (a === '--stdout') toStdout = true
        else if (a === '--out') outDir = argv[++i]
        else files.push(a)
    }
    const targets = files.length ? files : defaultStdlib()

    const reports: Report[] = []
    for (const f of targets) {
        let r: { text: string; report: Report }
        try {
            r = migrateFile(f)
        } catch (err: any) {
            console.error(`✗ ${f}: PARSE/EMIT FAILED — ${err.message}`)
            continue
        }
        if (toStdout) {
            process.stdout.write(r.text)
        } else if (!check) {
            const dest = join(outDir, f.replace(/^compiler\/src\/stdlib\/?/, ''))
            mkdirSync(dirname(dest), { recursive: true })
            writeFileSync(dest, r.text)
            r.report.out = dest
        }
        reports.push(r.report)
    }

    if (toStdout) return

    let totalComments = 0
    console.error('\nADR 0020 migration report')
    console.error('─'.repeat(62))
    for (const r of reports) {
        totalComments += r.comments
        const dest = r.out ? ` -> ${r.out}` : ''
        console.error(`${basename(r.file).padEnd(14)} ${String(r.elements).padStart(3)} defs  ${String(r.comments).padStart(3)} comments kept${dest}`)
        for (const flag of r.flags) console.error(`   ⚠ ${flag}`)
    }
    console.error('─'.repeat(62))
    console.error(`${reports.length} files, ${totalComments} comments preserved (own-line + trailing; @use + blank-line structure kept).`)
    if (check) console.error('(--check: no files written)')
}

main()
