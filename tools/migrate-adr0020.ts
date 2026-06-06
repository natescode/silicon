// SPDX-License-Identifier: MIT
/**
 * ADR 0020 codemod — migrate Silicon source from the current grammar to the
 * Odin-inspired grammar (bare definitions, always-parens calls, drop `&`,
 * `@mut`/`@type` markers). See docs/adr/0020-odin-inspired-grammar.md.
 *
 * STRATEGY: parse with the production parser, then RE-EMIT in ADR 0020 syntax.
 * This is a fork of compiler/src/fmt/formatter.ts with exactly three behavioural
 * changes (everything else is passed through unchanged):
 *
 *   1. formatDefinition  — drop @fn/@global (bare); @local/@var -> `@mut`;
 *                          @struct -> `@type Name := { fields }`; keep @type.
 *   2. formatFunctionCall — `&name a, b`  ->  `name(a, b)`  (drop &, add parens).
 *                          Works uniformly for user calls AND `&@if`/`&@loop`/…
 *   3. formatBinOp        — drop the call-operand paren reconstruction (always-
 *                          parens makes `f(x) + y` unambiguous); keep the
 *                          BinaryOp-right-operand parens (no precedence table).
 *
 * KNOWN LIMITATIONS (by design — an AST codemod cannot see what the grammar
 * discards):
 *   - Single-line `#` comments are stripped by the lexer and are NOT preserved.
 *     The leading license/doc header block is re-attached verbatim as a
 *     mitigation; interior `#` comments are lost (count reported per file).
 *   - `.` path separators are normalised to `::` (semantically identical).
 *   - `@struct`/`@enum`/`@extern` conversions are best-effort and flagged for
 *     human review (the type-context struct grammar is not yet implemented).
 *
 * USAGE (always non-destructive — never overwrites sources):
 *   bun run tools/migrate-adr0020.ts                  # migrate the whole stdlib -> build/adr0020/
 *   bun run tools/migrate-adr0020.ts --check          # dry run: parse + report only, write nothing
 *   bun run tools/migrate-adr0020.ts --stdout f.si    # print one file's migration to stdout
 *   bun run tools/migrate-adr0020.ts --out dir a.si b.si
 */

import { parseToAst } from '../compiler/src/parser/handwritten/parser'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

const IND = '    '
const ind = (d: number) => IND.repeat(d)

// Per-run diagnostics surfaced to the operator.
interface Report { file: string; out: string; elements: number; lineCommentsDropped: number; flags: string[] }
const FLAGS: string[] = [] // current-file flag sink

// ---------------------------------------------------------------------------
// Emitter (forked from compiler/src/fmt/formatter.ts — ADR 0020 rules)
// ---------------------------------------------------------------------------

function emitProgram(program: any): string {
    const parts: string[] = []
    for (let i = 0; i < program.elements.length; i++) {
        const el = program.elements[i]
        if (i > 0 && el.type === 'Definition') parts.push('')
        parts.push(emitTop(el, 0))
    }
    return parts.join('\n') + '\n'
}

function emitTop(node: any, depth: number): string {
    if (node.type === 'DocComment') return ind(depth) + '##' + node.content
    return ind(depth) + emit(node, depth) + ';'
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
// Uniform for user calls (`&add 1,2` -> `add(1, 2)`), zero-arg (`&print` ->
// `print()`), namespaced (`&WASM::i32_store ...`), and intrinsics (`&@if ...`
// -> `@if(...)`, `&@loop ...` -> `@loop(...)`).
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

function emitBlock(b: any, depth: number): string {
    if (b.items.length === 0 && !b.trailing) return '{}'
    const inner = depth + 1
    const lines: string[] = ['{']
    for (const item of b.items) lines.push(ind(inner) + emit(item, inner) + ';')
    if (b.trailing) lines.push(ind(inner) + emit(b.trailing, inner))   // trailing expr: no ';'
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
// Header preservation + comment accounting
// ---------------------------------------------------------------------------

/** Capture the leading run of comment/blank lines (SPDX + module doc) verbatim. */
function leadingHeader(src: string): string {
    const lines = src.split('\n')
    const head: string[] = []
    for (const line of lines) {
        if (/^\s*#/.test(line) || line.trim() === '') head.push(line)
        else break
    }
    // trim a trailing blank so we control spacing
    while (head.length && head[head.length - 1].trim() === '') head.pop()
    return head.length ? head.join('\n') + '\n\n' : ''
}

/** Count single-line `#` comments (not `##`) that the AST drops. */
function countLineComments(src: string): number {
    let n = 0
    for (const line of src.split('\n')) {
        const t = line.trimStart()
        if (t.startsWith('##')) continue
        if (t.startsWith('#')) { n++; continue }
        // trailing comment after code (rough — ignores '#' inside strings)
        const i = line.indexOf('#')
        if (i > 0 && line[i + 1] !== '#') n++
    }
    return n
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function migrateFile(path: string): { text: string; report: Report } {
    FLAGS.length = 0
    const src = readFileSync(path, 'utf8')
    // `@use '...';` is resolved by preprocessing in the real pipeline and is NOT
    // part of the parser grammar — pull the lines out, parse the rest, and
    // re-emit them verbatim (ADR 0020 leaves @use unchanged).
    const useLines: string[] = []
    const stripped = src.split('\n').map(line => {
        if (/^\s*@use\b/.test(line)) { useLines.push(line.trim().replace(/;?\s*$/, ';')); return '' }
        return line
    }).join('\n')
    const ast = parseToAst(stripped)
    const header = leadingHeader(src)
    const useBlock = useLines.length ? useLines.join('\n') + '\n\n' : ''
    const text = header + useBlock + emitProgram(ast)
    return {
        text,
        report: {
            file: path,
            out: '',
            elements: ast.elements.length,
            // exclude comments preserved in the leading header from the drop count
            lineCommentsDropped: Math.max(0, countLineComments(src) - countLineComments(header)),
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

    // Summary
    let totalDropped = 0
    console.error('\nADR 0020 migration report')
    console.error('─'.repeat(60))
    for (const r of reports) {
        totalDropped += r.lineCommentsDropped
        const dest = r.out ? ` -> ${r.out}` : ''
        console.error(`${basename(r.file).padEnd(14)} ${String(r.elements).padStart(3)} defs  ${String(r.lineCommentsDropped).padStart(3)} # dropped${dest}`)
        for (const flag of r.flags) console.error(`   ⚠ ${flag}`)
    }
    console.error('─'.repeat(60))
    console.error(`${reports.length} files, ${totalDropped} interior '#' comments not preserved (leading header kept).`)
    if (check) console.error('(--check: no files written)')
}

main()
