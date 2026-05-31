/**
 * Workspace — per-document cached parse / elaborate / typecheck results,
 * plus the cross-file @use graph + symbol index used by go-to-definition.
 *
 * The cache key is the document's LSP URI; entries are invalidated on
 * `update(uri, text)`.  Per-file parse cost is small enough (sub-ms for
 * typical files) that we re-run the whole pipeline on every change
 * rather than diff at AST level — see docs/language-server-plan.html
 * §6 "Granularity of re-checking".
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** LSP URIs are file:// URLs.  Convert in both directions. */
const uriToPath = (uri: string): string => fileURLToPath(uri)
const pathToUri = (p: string): string => pathToFileURL(p).href
// The LSP is a thin consumer of the compiler's public CaaS surface — the same
// pipeline the CLI uses.  `check()` runs parse → elaborate → typecheck and
// returns Diagnostics directly (no manual error conversion needed).
import { check, loadModules, type ModuleRegistry, type Diagnostic as SiliconDiag } from '@silicon/compiler'
import type { SymbolEntry } from './symbol-index.ts'
import { buildSymbolIndex } from './symbol-index.ts'

export interface DocAnalysis {
    uri: string
    text: string
    diagnostics: SiliconDiag[]
    symbols: SymbolEntry[]
    /** Other workspace files this document depends on via @use. */
    uses: string[]
}

export class Workspace {
    private readonly docs = new Map<string, DocAnalysis>()
    private moduleRegistry: ModuleRegistry | undefined

    /** Cached for the whole workspace — same registry the CLI uses. */
    private ensureModules(rootHint: string): ModuleRegistry {
        if (!this.moduleRegistry) {
            try {
                this.moduleRegistry = loadModules(rootHint)
            } catch {
                this.moduleRegistry = new Map() as unknown as ModuleRegistry
            }
        }
        return this.moduleRegistry
    }

    /** Re-analyse a document; call on open / change / save. */
    update(uri: string, text: string): DocAnalysis {
        const file = uriToPath(uri)
        const root = workspaceRootFor(file)

        // Strip @use 'path.si'; directives before parsing.  Stage 0's
        // grammar doesn't recognise @use — it's resolved by the
        // useResolver preprocessor before parse() in the normal CLI
        // flow.  For per-document LSP analysis we replace the directive
        // with same-length whitespace so error line/column offsets in
        // diagnostics still match the original source.
        const parserInput = stripUseDirectives(text)

        // Full front-end via the public CaaS pipeline.  check() never throws on
        // user errors — every parse/elaborate/typecheck failure comes back as a
        // Diagnostic, so no manual try/catch or error conversion is needed.
        const modules = this.ensureModules(root)
        const { diagnostics } = check(parserInput, { file, moduleRegistry: modules })
        const diags: SiliconDiag[] = [...diagnostics]

        // Symbol index is built from the text directly (faster + has
        // proper positions; Stage 0's AST doesn't carry sourceLocation
        // on Definition / TypedIdentifier nodes consistently).
        const symbols = buildSymbolIndex(uri, text)
        const uses = extractUsesFromText(text, file)

        // Suppress diagnostics that arise purely because the per-file
        // typechecker can't see symbols imported via @use.  Until the
        // LSP grows cross-file typechecking, these are false positives
        // the user can't act on — the dependency was declared
        // explicitly with @use 'path.si'.  Every other diagnostic is
        // kept.
        //
        // Two patterns covered:
        //   E0004 — direct reference to an @use'd name.
        //   E0002 — a mismatch whose `expected` or `actual` is the
        //           Unknown sentinel `<unknown>`, which the
        //           typechecker assigns to anything it couldn't
        //           resolve.  We only apply this suppression when the
        //           file actually has @use directives, so single-file
        //           code still surfaces real Unknown-in-mismatch bugs.
        const visibleNames = this.namesFromUses(uses)
        const hasUses = uses.length > 0
        const filteredDiags = diags.filter(d => {
            if (d.code === 'E0004') {
                const m = d.message.match(/unbound identifier ['"`]([^'"`]+)['"`]/i)
                if (m && visibleNames.has(m[1])) return false
            }
            if (d.code === 'E0002' && hasUses && /<unknown>/.test(d.message)) {
                return false
            }
            return true
        })

        const analysis: DocAnalysis = {
            uri, text,
            diagnostics: filteredDiags, symbols, uses,
        }
        this.docs.set(uri, analysis)
        return analysis
    }

    /** Names exported by any of the @use'd files currently in cache. */
    private namesFromUses(uses: string[]): Set<string> {
        const out = new Set<string>()
        for (const u of uses) {
            const a = this.docs.get(u)
            if (!a) continue
            for (const s of a.symbols) {
                if (s.kind === 'local' || s.kind === 'param') continue
                out.add(s.name)
            }
        }
        return out
    }

    get(uri: string): DocAnalysis | undefined { return this.docs.get(uri) }

    /** All open + cached documents. */
    all(): DocAnalysis[] { return [...this.docs.values()] }

    /** Find a symbol by name, scanning the current doc first, then @use'd files. */
    resolveSymbol(uri: string, name: string): SymbolEntry | undefined {
        const here = this.docs.get(uri)
        if (!here) return undefined
        const local = here.symbols.find(s => s.name === name)
        if (local) return local
        // Walk @use graph.  In v1 alpha we only consult docs already loaded.
        for (const useUri of here.uses) {
            const other = this.docs.get(useUri)
            if (!other) continue
            const hit = other.symbols.find(s => s.name === name && s.kind !== 'local')
            if (hit) return hit
        }
        return undefined
    }

    /** Eagerly load @use'd files from disk so cross-file resolution works
     *  even before the user opens them.  Called when the workspace opens. */
    primeUses(uri: string): void {
        const analysis = this.docs.get(uri)
        if (!analysis) return
        for (const useUri of analysis.uses) {
            if (this.docs.has(useUri)) continue
            const filePath = uriToPath(useUri)
            try {
                const text = fs.readFileSync(filePath, 'utf-8')
                this.update(useUri, text)
            } catch {
                // Missing @use'd file is a diagnostic the elaborator already raises.
            }
        }
    }
}

/**
 * Replace every `@use '...';` directive with same-length whitespace.
 * Keeps line + column offsets stable so diagnostics from the parser /
 * elaborator / typechecker still point at the right positions in the
 * original document.  Trailing semicolon and any inline `# comment` are
 * absorbed too if they're on the same line as the directive.
 */
function stripUseDirectives(text: string): string {
    return text.replace(
        /@use\s+'[^']*'\s*;?[ \t]*(?:#[^\n\r]*)?/g,
        (match) => match.replace(/[^\n\r]/g, ' '),
    )
}

/**
 * Find `@use 'path.si'` directives by regex over the source text.
 * Same rationale as the text-based symbol index: more reliable than
 * walking the Stage 0 AST and easier to keep in sync with the language
 * as it grows.
 */
function extractUsesFromText(text: string, currentFile: string): string[] {
    const dir = path.dirname(currentFile)
    const out: string[] = []
    const re = /@use\s+'([^']+)'/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
        out.push(pathToUri(path.resolve(dir, m[1])))
    }
    return out
}

/**
 * Heuristically find the workspace root containing the given file.
 * Walks parents looking for a marker (silicon.toml, package.json, .git).
 * Falls back to the file's directory.
 */
function workspaceRootFor(filePath: string): string {
    let dir = path.dirname(filePath)
    const root = path.parse(dir).root
    while (dir !== root) {
        for (const marker of ['silicon.toml', 'package.json', '.git']) {
            if (fs.existsSync(path.join(dir, marker))) return dir
        }
        dir = path.dirname(dir)
    }
    return path.dirname(filePath)
}
