// SPDX-License-Identifier: MIT
/**
 * ADR-0024 — component / module / file assembler.
 *
 * Statically merges every MODULE of a COMPONENT (the `sgl.toml`-rooted dir) into
 * a single Silicon source string for the existing flat `compile()` pipeline —
 * exactly the "source-level static merge before codegen" the ADR prescribes.
 *
 * The three tiers:
 *   - COMPONENT = the directory rooted by `sgl.toml` (handled by the CLI).
 *   - MODULE    = a directory of `.si` files. Files directly in the source root
 *                 (`src/`) form the ROOT module (callable unqualified); every
 *                 sub-directory containing `.si` files is a sibling module named
 *                 by its base name (`strings::trim`).
 *   - FILE      = a physical split only — all files in a module dir share one
 *                 Go-style package-block scope (auto-included, lexical order).
 *
 * Mechanism — NAME-PREFIXING (ADR §Dependencies / Implementation pointer):
 *   A sub-module `M`'s top-level definitions and their in-module references are
 *   rewritten to plain `M__name` identifiers, and every cross-module reference
 *   `M::f` (anywhere) becomes `M__f`. The result is one flat program the
 *   shipped compiler accepts verbatim — modules/files cost ZERO runtime. `M__f`
 *   is a normal user function: `watId` leaves it untouched (no `::`), so the
 *   lowerer never routes it through the import-only `lowerModuleCall` path.
 *
 *   The rewrite is driven by the AST (scope-aware, so a local/param/match/loop
 *   binding that shadows a top-level def name is NOT prefixed) and applied as
 *   surgical text-edits keyed on each node's `relSpan`, preserving the rest of
 *   the source (comments, formatting) and keeping diagnostics roughly aligned.
 *
 * Visibility (`@pub`): private-by-default at the module edge. A sub-module
 * member is cross-module callable as `M::f` only when marked `@pub`; otherwise
 * referencing it from another module is `E-PRIV`. Within a module, every file
 * sees every sibling's top-level defs (Go package-block).
 *
 * `@use` is scoped down (ADR §Fate of `@use`): intra-component path `@use`s are
 * redundant (files auto-include) and emit a deprecation warning; the bare-name
 * stdlib include (`@use 'io';`) is retained verbatim.
 */

import { dirname, resolve, isAbsolute, basename, join } from 'path'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { parseToAst } from '../parser/handwritten/parser'
import { resolveUses, type StdlibHook } from './useResolver'
import type { LowerTarget } from '../ir/lower'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ComponentDiagnostic {
    code: string                          // E-DUP-MOD, E-DUP-DEF, E-MOD-TOPSTMT, E-MOD-CYCLE, E-PRIV, E-NO-MAIN, W-USE-REDUNDANT
    severity: 'error' | 'warning'
    message: string
    file?: string
    line?: number
}

export interface AssembledComponent {
    /** Merged source, ready for `compile()`. */
    source: string
    diagnostics: ComponentDiagnostic[]
    /** Sibling (non-root) module names discovered under the source root. */
    moduleNames: string[]
    /** Whether the root module defines `main` (false ⇒ library component). */
    hasMain: boolean
}

export interface AssembleOptions {
    target?: LowerTarget
    /** Env + user-wrapper module names (registry) — a source module colliding
     *  with one of these is `E-DUP-MOD`. */
    reservedModuleNames?: Set<string>
    stdlib?: StdlibHook
    // Injectable filesystem (defaults to node fs) — used by tests.
    readFile?: (abs: string) => string | undefined
    fileExists?: (abs: string) => boolean
    /** List a directory: returns entries with name + isDir, or undefined if not a dir. */
    listDir?: (abs: string) => { name: string; isDir: boolean }[] | undefined
}

type Edit = { start: number; end: number; text: string }

interface ModuleInfo {
    name: string                  // module name (sub-module) or '' for root
    dir: string
    /** Auto-included source (all `.si` files concatenated, `@use` stripped). */
    chunk: string
    ast: any
    /** All top-level renameable def names (excludes @extern / @export decls). */
    defs: Set<string>
    /** Subset of `defs` marked `@pub`. */
    pub: Set<string>
    /** Module names this module references via `other::`. */
    refs: Set<string>
}

// ---------------------------------------------------------------------------
// Filesystem helpers (injectable)
// ---------------------------------------------------------------------------

function defaultListDir(abs: string): { name: string; isDir: boolean }[] | undefined {
    try {
        if (!statSync(abs).isDirectory()) return undefined
        return readdirSync(abs).map(name => ({ name, isDir: statSync(join(abs, name)).isDirectory() }))
    } catch { return undefined }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Assemble the component rooted at the entry file's directory.
 *
 * @param entryFile absolute path to the entry `.si` file (e.g. `…/src/main.si`).
 *                  Its directory is the ROOT module; sub-directories are modules.
 */
export function assembleComponent(entryFile: string, opts: AssembleOptions = {}): AssembledComponent {
    const readFile = opts.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : undefined))
    const fileExists = opts.fileExists ?? existsSync
    const listDir = opts.listDir ?? defaultListDir
    const diagnostics: ComponentDiagnostic[] = []

    const rootDir = dirname(resolve(entryFile))

    // 1. Discover modules: root dir + every descendant dir with >=1 .si file.
    const { rootFiles, subDirs } = discoverModules(rootDir, listDir, diagnostics, opts.reservedModuleNames)
    const sourceModuleNames = new Set(subDirs.map(s => s.name))

    // 2. Build each module's auto-included chunk (files concatenated, @use handled).
    const autoIncludedPaths = new Set<string>([
        ...rootFiles,
        ...subDirs.flatMap(s => s.files),
    ].map(p => resolve(p)))

    const externalUses: string[] = []   // bare stdlib + out-of-component path @use, fed to resolveUses
    const buildChunk = (dir: string, files: string[]): string => {
        const parts: string[] = []
        for (const f of files) {
            const raw = readFile(f)
            if (raw === undefined) continue
            parts.push(stripAndCollectUses(raw, f, autoIncludedPaths, externalUses, diagnostics))
        }
        return parts.join('\n\n')
    }

    const root: ModuleInfo = blankModule('', rootDir, buildChunk(rootDir, rootFiles))
    const subs: ModuleInfo[] = subDirs.map(s => blankModule(s.name, s.dir, buildChunk(s.dir, s.files)))

    // 3. Pass 1 — parse every chunk; collect defs / pub / top-level diagnostics.
    parseModule(root, diagnostics, /*isRoot*/ true)
    for (const m of subs) parseModule(m, diagnostics, /*isRoot*/ false)

    const pubByModule = new Map<string, ModuleInfo>()
    for (const m of subs) pubByModule.set(m.name, m)

    // 4. Pass 2 — rewrite each chunk (prefix sub-module defs/refs, cross-module
    //    refs everywhere, with E-PRIV enforcement) and record cross-module edges.
    const rootRewritten = rewriteRoot(root, sourceModuleNames, pubByModule, diagnostics)
    const subsRewritten = subs.map(m => rewriteSub(m, sourceModuleNames, pubByModule, diagnostics))

    // 5. Cycle ban (E-MOD-CYCLE) over the observed cross-module graph.
    detectCycles(root, subs, diagnostics)

    // 6. Stdlib + out-of-component includes via the shipped resolver (dedup,
    //    cycle detection, wasm-gc shadow swap all preserved verbatim).
    let stdlibSource = ''
    if (externalUses.length > 0) {
        const synthetic = dedupe(externalUses).map(u => `@use '${u}';`).join('\n') + '\n'
        const syntheticPath = join(rootDir, '__component_uses__.si')
        try {
            stdlibSource = resolveUses(synthetic, syntheticPath, {
                target: opts.target,
                stdlib: opts.stdlib,
                readFile: opts.readFile,
                fileExists: opts.fileExists,
            }).source
        } catch (e: any) {
            diagnostics.push({ code: 'E-USE', severity: 'error', message: String(e?.message ?? e) })
        }
    }

    // 7. Concatenate: stdlib, then sub-modules, then root (root last so its
    //    trailing top-level `main();` stays at the end, matching today).
    const merged = [
        stdlibSource,
        ...subsRewritten.map((src, i) => regionWrap(subs[i].name, src)),
        regionWrap('<root>', rootRewritten),
    ].filter(s => s.trim().length > 0).join('\n')

    return {
        source: merged,
        diagnostics,
        moduleNames: subs.map(m => m.name),
        hasMain: root.defs.has('main'),
    }
}

// ---------------------------------------------------------------------------
// Module discovery
// ---------------------------------------------------------------------------

function discoverModules(
    rootDir: string,
    listDir: NonNullable<AssembleOptions['listDir']>,
    diagnostics: ComponentDiagnostic[],
    reserved?: Set<string>,
): { rootFiles: string[]; subDirs: { name: string; dir: string; files: string[] }[] } {
    const entries = listDir(rootDir) ?? []
    const rootFiles = entries
        .filter(e => !e.isDir && e.name.endsWith('.si'))
        .map(e => join(rootDir, e.name))
        .sort()

    const subDirs: { name: string; dir: string; files: string[] }[] = []
    const seen = new Map<string, string>()   // module name -> dir (E-DUP-MOD)

    // Recursively visit descendant directories; each dir with >=1 direct .si is
    // a module named by its base name. On-disk nesting adds NO namespace depth
    // (ADR §Directory-to-module rule — flat).
    const visit = (dir: string): void => {
        const es = listDir(dir) ?? []
        const files = es.filter(e => !e.isDir && e.name.endsWith('.si')).map(e => join(dir, e.name)).sort()
        if (dir !== rootDir && files.length > 0) {
            const name = basename(dir)
            const prior = seen.get(name)
            if (prior) {
                diagnostics.push({
                    code: 'E-DUP-MOD', severity: 'error',
                    message: `duplicate module '${name}'\n  ${prior}\n  ${dir}\n  Module base names must be unique within a component (rename one directory).`,
                })
            } else if (reserved?.has(name)) {
                diagnostics.push({
                    code: 'E-DUP-MOD', severity: 'error',
                    message: `module '${name}' (${dir}) collides with a built-in / host-wrapper module of the same name.`,
                })
            } else {
                seen.set(name, dir)
                subDirs.push({ name, dir, files })
            }
        }
        for (const e of es) if (e.isDir) visit(join(dir, e.name))
    }
    visit(rootDir)

    return { rootFiles, subDirs }
}

// ---------------------------------------------------------------------------
// @use handling (strip + collect)
// ---------------------------------------------------------------------------

const USE_RE = /^[ \t]*@use[ \t]+'([^'\n\r]+)'[ \t]*;[ \t]*(?:#[^\n\r]*)?$/gm
const BARE_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** Strip `@use` directives from a file's source. Bare-name (stdlib) and any
 *  out-of-component path includes are collected into `externalUses`; a path
 *  include that points at an auto-included file (a same-module sibling or any
 *  other module's file) is redundant and gets a deprecation warning. */
function stripAndCollectUses(
    src: string,
    filePath: string,
    autoIncludedPaths: Set<string>,
    externalUses: string[],
    diagnostics: ComponentDiagnostic[],
): string {
    USE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = USE_RE.exec(src)) !== null) {
        // honour `#` comment shadowing
        const lineStart = src.lastIndexOf('\n', m.index) + 1
        const line = src.slice(lineStart, m.index + m[0].length)
        const hash = line.indexOf('#'), use = line.indexOf('@use')
        if (hash >= 0 && hash < use) continue
        const raw = m[1]
        if (BARE_RE.test(raw)) {
            externalUses.push(raw)                          // stdlib include — retained
            continue
        }
        const abs = isAbsolute(raw) ? raw : resolve(dirname(filePath), raw)
        if (autoIncludedPaths.has(resolve(abs))) {
            diagnostics.push({
                code: 'W-USE-REDUNDANT', severity: 'warning', file: filePath,
                message: `redundant \`@use '${raw}';\` — files in a module are auto-included; call other modules as \`mod::name\` instead (ADR-0024).`,
            })
        } else {
            externalUses.push(abs)                          // out-of-component path — kept
        }
    }
    return src.replace(USE_RE, '')
}

// ---------------------------------------------------------------------------
// Parsing + collection (pass 1)
// ---------------------------------------------------------------------------

const RENAMEABLE_KW = new Set(['@fn', '@global', '@local', '@let', '@var', '@type', '@type_sum', '@enum', '@struct'])

function blankModule(name: string, dir: string, chunk: string): ModuleInfo {
    return { name, dir, chunk, ast: null, defs: new Set(), pub: new Set(), refs: new Set() }
}

function unwrap(node: any): any {
    let n = node
    while (n && (n.type === 'Element' || n.type === 'Item' || n.type === 'Statement')) n = n.value
    return n
}

function parseModule(m: ModuleInfo, diagnostics: ComponentDiagnostic[], isRoot: boolean): void {
    if (m.chunk.trim().length === 0) { m.ast = { type: 'Program', elements: [] }; return }
    let prog: any
    try {
        prog = parseToAst(m.chunk)
    } catch (e: any) {
        diagnostics.push({
            code: 'E-PARSE', severity: 'error',
            file: m.dir, message: `failed to parse module '${m.name || '<root>'}': ${String(e?.message ?? e)}`,
        })
        m.ast = { type: 'Program', elements: [] }
        return
    }
    m.ast = prog
    const seenDef = new Map<string, true>()
    for (const el of prog.elements ?? []) {
        const n = unwrap(el)
        if (!n) continue
        if (n.type === 'DocComment') continue
        if (n.type !== 'Definition') {
            // Top-level executable statement — only the ROOT module may carry them
            // (ADR §File auto-inclusion (b)); elsewhere their cross-file order is
            // ill-defined.
            if (!isRoot) {
                diagnostics.push({
                    code: 'E-MOD-TOPSTMT', severity: 'error', file: m.dir,
                    message: `module '${m.name}' has a top-level executable statement — move it into a fn, or into the root module (ADR-0024).`,
                })
            }
            continue
        }
        if (n.keyword === '@export' || n.keyword === '@extern') continue   // not renameable module members
        const name: string | undefined = n.name?.name
        if (!name) continue
        if (seenDef.has(name)) {
            diagnostics.push({
                code: 'E-DUP-DEF', severity: 'error', file: m.dir,
                message: `duplicate definition '${name}' in module '${m.name || '<root>'}' — two files (or one file) define the same top-level name.`,
            })
        }
        seenDef.set(name, true)
        m.defs.add(name)
        if (n.pub === true) m.pub.add(name)
    }
}

// ---------------------------------------------------------------------------
// Rewrite (pass 2)
// ---------------------------------------------------------------------------

function applyEdits(src: string, edits: Edit[]): string {
    // Apply right-to-left so earlier offsets stay valid.
    const sorted = edits.slice().sort((a, b) => b.start - a.start)
    let out = src
    let lastStart = Infinity
    for (const e of sorted) {
        if (e.end > lastStart) continue   // defensive: skip overlaps
        out = out.slice(0, e.start) + e.text + out.slice(e.end)
        lastStart = e.start
    }
    return out
}

/** ROOT module: only rewrite cross-module `mod::f` references (mod is a source
 *  module). Root defs stay flat/global (callable unqualified everywhere). */
function rewriteRoot(
    m: ModuleInfo,
    sourceModuleNames: Set<string>,
    pubByModule: Map<string, ModuleInfo>,
    diagnostics: ComponentDiagnostic[],
): string {
    const edits: Edit[] = []
    const visit = (node: any) => walkRefs(node, ns => {
        if (ns.path?.length === 2 && sourceModuleNames.has(ns.path[0])) {
            emitCrossModuleEdit(ns, '', m, pubByModule, diagnostics, edits)
        }
    })
    for (const el of m.ast.elements ?? []) visit(el)
    return applyEdits(m.chunk, edits)
}

/** SUB module: prefix its top-level defs to `M__name`, prefix in-module
 *  references to them (scope-aware), and rewrite cross-module refs. */
function rewriteSub(
    m: ModuleInfo,
    sourceModuleNames: Set<string>,
    pubByModule: Map<string, ModuleInfo>,
    diagnostics: ComponentDiagnostic[],
): string {
    const edits: Edit[] = []
    const M = m.name

    // (a) Definition sites — def-line name (relSpan) + sig-line name (scan).
    for (const el of m.ast.elements ?? []) {
        const n = unwrap(el)
        if (!n || n.type !== 'Definition') continue
        const name: string | undefined = n.name?.name
        if (!name) continue
        // @export STATEMENTS that name a member of THIS module get prefixed too,
        // so the emitted export references the renamed function.
        if (n.keyword === '@export') {
            if (m.defs.has(name) && n.relSpan) edits.push({ start: n.relSpan.start, end: n.relSpan.end, text: `${M}__${name}` })
            continue
        }
        if (n.keyword === '@extern') continue          // host import — keep host name
        if (!m.defs.has(name)) continue
        if (n.relSpan) edits.push({ start: n.relSpan.start, end: n.relSpan.end, text: `${M}__${name}` })
        const sig = findSigNameSpan(m.chunk, n)
        if (sig) edits.push({ start: sig.start, end: sig.end, text: `${M}__${name}` })
    }

    // (b) Reference sites — scope-aware (a shadowing local/param/match/loop bind
    //     is left alone).
    const frames: Set<string>[] = []
    const emitRef = (ns: any) => {
        if (!ns?.path || !ns.relSpan) return
        if (ns.path.length === 1) {
            const name = ns.path[0]
            if (m.defs.has(name) && !frames.some(f => f.has(name))) {
                edits.push({ start: ns.relSpan.start, end: ns.relSpan.end, text: `${M}__${name}` })
            }
        } else if (ns.path.length === 2 && sourceModuleNames.has(ns.path[0])) {
            emitCrossModuleEdit(ns, M, m, pubByModule, diagnostics, edits)
        }
    }
    for (const el of m.ast.elements ?? []) {
        const n = unwrap(el)
        if (!n || n.type !== 'Definition') continue
        walkScoped(n.binding, frames, emitRef, m.refs, sourceModuleNames, n.params)
    }

    return applyEdits(m.chunk, edits)
}

/** Rewrite a cross-module `mod::f` Namespace to `mod__f`, recording the edge and
 *  enforcing `@pub` (E-PRIV) when `mod` is a different source module. */
function emitCrossModuleEdit(
    ns: any,
    selfModule: string,
    m: ModuleInfo,
    pubByModule: Map<string, ModuleInfo>,
    diagnostics: ComponentDiagnostic[],
    edits: Edit[],
): void {
    const mod = ns.path[0], f = ns.path[1]
    m.refs.add(mod)
    if (mod !== selfModule) {
        const target = pubByModule.get(mod)
        if (target && target.defs.has(f) && !target.pub.has(f)) {
            diagnostics.push({
                code: 'E-PRIV', severity: 'error', file: m.dir,
                message: `'${mod}::${f}' is private to module '${mod}' — mark it \`@pub\` on its signature line to call it across the module boundary (ADR-0024).`,
            })
        }
    }
    edits.push({ start: ns.relSpan.start, end: ns.relSpan.end, text: `${mod}__${f}` })
}

// ---------------------------------------------------------------------------
// Scope-aware AST walk
// ---------------------------------------------------------------------------

/** Walk every Namespace reference in `node`, invoking `onRef`. No scope —
 *  used by the root module (which only rewrites qualified cross-module refs). */
function walkRefs(node: any, onRef: (ns: any) => void): void {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const x of node) walkRefs(x, onRef); return }
    if (node.type === 'Namespace') { onRef(node); return }
    if (node.type === 'FunctionCall' && node.name && typeof node.name === 'object') onRef(node.name)
    if (node.type === 'Assignment' && node.target) onRef(node.target)
    for (const k of Object.keys(node)) {
        if (k === 'sourceLocation' || k === 'relSpan' || k === 'name') continue
        const v = node[k]
        if (v && typeof v === 'object') walkRefs(v, onRef)
    }
}

/**
 * Scope-aware walk used by sub-modules: tracks bound names (params, nested
 * block-local definitions, `@match` pattern vars, the `@loop` index) so a
 * reference shadowed by a local binding is NOT prefixed.
 */
function walkScoped(
    node: any,
    frames: Set<string>[],
    emitRef: (ns: any) => void,
    refs: Set<string>,
    sourceModuleNames: Set<string>,
    paramSeed?: any[],
): void {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const x of node) walkScoped(x, frames, emitRef, refs, sourceModuleNames); return }

    switch (node.type) {
        case 'Namespace':
            emitRef(node)
            return
        case 'FunctionCall': {
            const callee = node.name
            const calleeName = typeof callee === 'string' ? callee : undefined
            if (calleeName === '@match') { walkMatch(node, frames, emitRef, refs, sourceModuleNames); return }
            if (calleeName === '@loop') { walkLoop(node, frames, emitRef, refs, sourceModuleNames); return }
            if (callee && typeof callee === 'object') emitRef(callee)
            for (const a of node.args ?? []) walkScoped(a, frames, emitRef, refs, sourceModuleNames)
            return
        }
        case 'Assignment':
            if (node.target) emitRef(node.target)
            walkScoped(node.value, frames, emitRef, refs, sourceModuleNames)
            return
        case 'Block': {
            frames.push(new Set())
            for (const item of node.items ?? []) walkScoped(item, frames, emitRef, refs, sourceModuleNames)
            if (node.trailing) walkScoped(node.trailing, frames, emitRef, refs, sourceModuleNames)
            frames.pop()
            return
        }
        case 'Definition': {
            // Nested/local definition: bind its name in the enclosing block scope,
            // then walk its body in a fresh param scope.
            const nm = node.name?.name
            if (nm && frames.length > 0) frames[frames.length - 1].add(nm)
            const seed = new Set<string>((node.params ?? []).map((p: any) => p?.name).filter(Boolean))
            frames.push(seed)
            walkScoped(node.binding, frames, emitRef, refs, sourceModuleNames)
            frames.pop()
            return
        }
    }

    // Top-level entry (a Definition's binding passed directly): seed params.
    if (paramSeed) {
        const seed = new Set<string>(paramSeed.map((p: any) => p?.name).filter(Boolean))
        frames.push(seed)
        walkChildren(node, frames, emitRef, refs, sourceModuleNames)
        frames.pop()
        return
    }
    walkChildren(node, frames, emitRef, refs, sourceModuleNames)
}

function walkChildren(node: any, frames: Set<string>[], emitRef: (ns: any) => void, refs: Set<string>, sourceModuleNames: Set<string>): void {
    for (const k of Object.keys(node)) {
        if (k === 'sourceLocation' || k === 'relSpan' || k === 'name') continue
        const v = node[k]
        if (v && typeof v === 'object') walkScoped(v, frames, emitRef, refs, sourceModuleNames)
    }
}

function walkMatch(node: any, frames: Set<string>[], emitRef: (ns: any) => void, refs: Set<string>, sourceModuleNames: Set<string>): void {
    const args = node.args ?? []
    if (args[0]) walkScoped(args[0], frames, emitRef, refs, sourceModuleNames)   // scrutinee
    for (let i = 1; i < args.length; i += 2) {
        const pattern = args[i], block = args[i + 1]
        const binders = collectPatternBinders(pattern)
        frames.push(new Set(binders))
        if (block) walkScoped(block, frames, emitRef, refs, sourceModuleNames)
        frames.pop()
    }
}

function walkLoop(node: any, frames: Set<string>[], emitRef: (ns: any) => void, refs: Set<string>, sourceModuleNames: Set<string>): void {
    const args = node.args ?? []
    const frame = new Set<string>()
    const v = args[0]
    if (v?.type === 'Namespace' && v.path?.length === 1) frame.add(v.path[0])   // loop index — a binder
    frames.push(frame)
    for (let i = 1; i < args.length; i++) walkScoped(args[i], frames, emitRef, refs, sourceModuleNames)
    frames.pop()
}

/** Names bound by a `@match` pattern (the `v` in `$Some v`). Variant/constructor
 *  names themselves are not binders and not rewritten. */
function collectPatternBinders(pattern: any): string[] {
    const out: string[] = []
    const visit = (n: any) => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) { n.forEach(visit); return }
        if ((n.type === 'Parameter' || n.type === 'TypedIdentifier') && typeof n.name === 'string') out.push(n.name)
        for (const k of Object.keys(n)) {
            if (k === 'sourceLocation' || k === 'relSpan') continue
            const v = n[k]
            if (v && typeof v === 'object') visit(v)
        }
    }
    visit(pattern)
    return out
}

// ---------------------------------------------------------------------------
// Signature-line name location
// ---------------------------------------------------------------------------

const SIG_NAME_RE = /^([ \t]*\\\\[ \t]*(?:@[A-Za-z_]\w*[ \t]+)*)([A-Za-z_]\w*)/

/** Locate the def-name token on the `\\` signature line immediately above a
 *  top-level definition, so it can be renamed in lock-step with the def line. */
function findSigNameSpan(chunk: string, def: any): { start: number; end: number } | null {
    if (!def.relSpan) return null
    const defLineStart = chunk.lastIndexOf('\n', def.relSpan.start - 1) + 1
    if (defLineStart <= 0) return null
    const prevLineEnd = defLineStart - 1            // the '\n' ending the previous line
    const prevLineStart = chunk.lastIndexOf('\n', prevLineEnd - 1) + 1
    const prevLine = chunk.slice(prevLineStart, prevLineEnd)
    const m = SIG_NAME_RE.exec(prevLine)
    if (!m) return null
    if (m[2] !== def.name?.name) return null
    const start = prevLineStart + m[1].length
    return { start, end: start + m[2].length }
}

// ---------------------------------------------------------------------------
// Cycle detection (E-MOD-CYCLE)
// ---------------------------------------------------------------------------

function detectCycles(root: ModuleInfo, subs: ModuleInfo[], diagnostics: ComponentDiagnostic[]): void {
    const byName = new Map<string, ModuleInfo>()
    for (const m of subs) byName.set(m.name, m)
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()
    for (const m of subs) color.set(m.name, WHITE)

    const stack: string[] = []
    const dfs = (name: string): void => {
        color.set(name, GRAY)
        stack.push(name)
        const m = byName.get(name)
        for (const dep of m?.refs ?? []) {
            if (dep === name || !byName.has(dep)) continue
            if (color.get(dep) === GRAY) {
                const at = stack.indexOf(dep)
                const cyc = [...stack.slice(at), dep]
                diagnostics.push({
                    code: 'E-MOD-CYCLE', severity: 'error',
                    message:
                        `module import cycle\n  ${cyc.join('  ->  ')}\n  Fix by one of:\n` +
                        `    1. move the shared piece into a third module both can call\n` +
                        `    2. pass the needed value in as a parameter (capability-style inversion)\n` +
                        `    3. merge these modules (files in one module may reference each other freely)`,
                })
            } else if (color.get(dep) === WHITE) {
                dfs(dep)
            }
        }
        stack.pop()
        color.set(name, BLACK)
    }
    for (const m of subs) if (color.get(m.name) === WHITE) dfs(m.name)
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function dedupe(xs: string[]): string[] {
    const seen = new Set<string>(); const out: string[] = []
    for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x) }
    return out
}

function regionWrap(label: string, src: string): string {
    return `# region module ${label}\n${src}\n# endregion ${label}`
}
