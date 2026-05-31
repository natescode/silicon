/**
 * Symbol index — find every named binding in a Silicon document
 * with a precise source range, by scanning the source text.
 *
 * v1 alpha builds positions directly from regexes over the document
 * text rather than from the AST, because Stage 0's AST builder
 * doesn't populate `sourceLocation` on every node we'd need (the
 * Definition.name / TypedIdentifier nodes specifically come through
 * with no position info).  A separate text scan is a few dozen lines
 * and gives us byte-precise ranges for outline / definition / hover.
 *
 * Scope: top-level @let / @fn / @var / @extern / @type / @stratum_*,
 * plus @local declarations inside each @fn body (no nested scope
 * tracking — we hoist every @local to the enclosing top-level def).
 */

export type SymbolKind =
    | 'fn' | 'let' | 'var' | 'extern' | 'type'
    | 'stratum' | 'local' | 'param' | 'use'

export interface Range {
    start: { line: number; character: number }
    end:   { line: number; character: number }
}

export interface SymbolEntry {
    uri:            string
    name:           string
    kind:           SymbolKind
    keyword:        string
    range:          Range  // entire definition line
    selectionRange: Range  // just the name token
    typeAnnotation?: string
    doc?:           string
    container?:     string // enclosing @fn name, if @local / @param
}

// Definition keywords this scanner recognises.  Order matters only
// for the @stratum_* prefix entries — they have to come before any
// plain @stratum entry would.
const DEF_KEYWORDS = [
    { kw: '@stratum_keyword',  kind: 'stratum' as SymbolKind },
    { kw: '@stratum_operator', kind: 'stratum' as SymbolKind },
    { kw: '@type_alias',       kind: 'type'    as SymbolKind },
    { kw: '@type_distinct',    kind: 'type'    as SymbolKind },
    { kw: '@type_sum',         kind: 'type'    as SymbolKind },
    { kw: '@type',             kind: 'type'    as SymbolKind },
    { kw: '@enum',             kind: 'type'    as SymbolKind },
    { kw: '@extern',           kind: 'extern'  as SymbolKind },
    { kw: '@fn',               kind: 'fn'      as SymbolKind },
    { kw: '@let',              kind: 'let'     as SymbolKind },
    { kw: '@var',              kind: 'var'     as SymbolKind },
    { kw: '@use',              kind: 'use'     as SymbolKind },
] as const

/**
 * Build the symbol index by scanning each line.
 *
 * `@fn name`, `@let name:Type`, `@stratum_keyword Name`, `@local x` —
 * the leading keyword followed by the first identifier is the symbol.
 * Multi-segment names (`@extern ns::fn`) are recognised but indexed
 * under the FULL `ns::fn` text since that's what call sites resolve.
 */
export function buildSymbolIndex(uri: string, text: string): SymbolEntry[] {
    const out: SymbolEntry[] = []
    const lines = text.split('\n')
    let pendingDoc: string | undefined
    let currentTop: string | undefined  // top-level container for @local

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        const line = lines[lineNo]
        const stripped = line.trimStart()
        const indent = line.length - stripped.length

        // ## doc comment → attach to next definition.  Single # is a
        // line comment; ignore as far as the index is concerned.
        if (stripped.startsWith('##')) {
            const txt = stripped.replace(/^##\s*/, '').trim()
            if (txt) pendingDoc = (pendingDoc ? pendingDoc + ' ' : '') + txt
            continue
        }
        if (stripped.startsWith('#')) continue

        const def = matchDefinition(stripped)
        if (!def) {
            if (stripped !== '') pendingDoc = undefined
            continue
        }

        const nameStart = indent + def.nameOffset
        const nameEnd   = nameStart + def.name.length
        const isLocal   = def.keyword === '@local'
        const container = isLocal ? currentTop : undefined

        const entry: SymbolEntry = {
            uri,
            name: def.name,
            kind: def.kind,
            keyword: def.keyword,
            range: {
                start: { line: lineNo, character: indent },
                end:   { line: lineNo, character: line.length },
            },
            selectionRange: {
                start: { line: lineNo, character: nameStart },
                end:   { line: lineNo, character: nameEnd },
            },
            typeAnnotation: def.typeAnnotation,
            doc: pendingDoc,
            container,
        }
        out.push(entry)
        pendingDoc = undefined

        // Top-level @fn / @let establishes the container for subsequent
        // @local declarations.  Anything indented beyond column 0 is
        // assumed to belong to the most recent top-level def.
        if (indent === 0 && (def.keyword === '@fn' || def.keyword === '@let')) {
            currentTop = def.name
        }

        // Pull params out of the same line for @fn / @let.
        if (def.keyword === '@fn' || def.keyword === '@let') {
            const after = line.slice(nameEnd)
            for (const p of extractParams(after, lineNo, nameEnd)) {
                out.push({ ...p, uri, container: def.name })
            }
        }
    }

    return out
}

interface MatchedDef {
    keyword: string
    kind:    SymbolKind
    name:    string
    /** Column offset of the name within the trimmed line. */
    nameOffset: number
    typeAnnotation?: string
}

function matchDefinition(line: string): MatchedDef | undefined {
    for (const { kw, kind } of DEF_KEYWORDS) {
        if (!line.startsWith(kw)) continue
        const after = line.slice(kw.length)
        if (after.length === 0 || !/^\s/.test(after) && after[0] !== ';') continue
        // `@kw <name>[<::name>...][:<Type>]` …
        const m = after.match(/^\s+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)(:\s*[A-Za-z_][A-Za-z0-9_]*)?/)
        if (!m) continue
        return {
            keyword:        kw,
            kind,
            name:           m[1],
            nameOffset:     kw.length + (after.length - after.trimStart().length),
            typeAnnotation: m[2]?.trim() || undefined,
        }
    }
    // @local — like above but the keyword is recognised separately so
    // the container detection above can use the indent test.
    if (line.startsWith('@local')) {
        const after = line.slice('@local'.length)
        const m = after.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)(:\s*[A-Za-z_][A-Za-z0-9_]*)?/)
        if (m) {
            return {
                keyword:        '@local',
                kind:           'local',
                name:           m[1],
                nameOffset:     '@local'.length + (after.length - after.trimStart().length),
                typeAnnotation: m[2]?.trim() || undefined,
            }
        }
    }
    return undefined
}

/**
 * Parse the parameter list from the rest of a definition line.
 * Recognises `name`, `name:Type`, separated by commas, stopping at `:=` or `{`.
 */
function extractParams(
    rest: string, lineNo: number, baseCol: number,
): Omit<SymbolEntry, 'uri' | 'container'>[] {
    const out: Omit<SymbolEntry, 'uri' | 'container'>[] = []
    // The slice begins after the function name.  Skip the optional
    // return-type annotation `:Type`, then everything up to `:=` / `{`
    // is the param list.
    let i = 0
    // Skip whitespace + optional `:RetType`.
    while (i < rest.length && /\s/.test(rest[i])) i++
    if (rest[i] === ':') {
        i++
        while (i < rest.length && /\s/.test(rest[i])) i++
        while (i < rest.length && /[A-Za-z0-9_]/.test(rest[i])) i++
    }
    const stop = findStop(rest, i)
    const paramText = rest.slice(i, stop)
    let col = baseCol + i
    let absStart = col
    // Walk identifiers — naive but accurate enough for the v1 outline.
    const re = /([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_]*))?/g
    let m: RegExpExecArray | null
    while ((m = re.exec(paramText)) !== null) {
        const nameStart = absStart + m.index
        const nameEnd   = nameStart + m[1].length
        out.push({
            name: m[1],
            kind: 'param',
            keyword: '@param',
            range: {
                start: { line: lineNo, character: nameStart },
                end:   { line: lineNo, character: nameEnd },
            },
            selectionRange: {
                start: { line: lineNo, character: nameStart },
                end:   { line: lineNo, character: nameEnd },
            },
            typeAnnotation: m[2] ? `:${m[2]}` : undefined,
        })
    }
    return out
}

function findStop(s: string, from: number): number {
    for (let i = from; i < s.length - 1; i++) {
        if (s[i] === ':' && s[i + 1] === '=') return i
        if (s[i] === '{' || s[i] === ';') return i
    }
    return s.length
}
