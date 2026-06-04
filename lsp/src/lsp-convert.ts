/**
 * CaaS ↔ LSP translation helpers.
 *
 * The compiler's CaaS surface uses 1-based `(line, col)` with a `length`
 * (`SourceSpan`); LSP uses 0-based `(line, character)` half-open `Range`s.
 * Every handler converts through the helpers here so the coordinate math
 * lives in exactly one place.
 */

import {
    DiagnosticSeverity,
    SymbolKind as LspSymbolKind,
    CompletionItemKind,
    SemanticTokenTypes,
} from 'vscode-languageserver/node.js'
import type { Range, Location } from 'vscode-languageserver/node.js'
import type {
    Diagnostic as SiliconDiag,
    SourceSpan,
    SourceRange,
    CaaSSymbol,
    SymbolKind as CaaSSymbolKind,
    CompletionItem as CaaSCompletionItem,
} from '@silicon/compiler'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const uriToPath = (uri: string): string => fileURLToPath(uri)
export const pathToUri = (p: string): string => pathToFileURL(p).href

/** A CaaS span/path may be a file path or already a URI; normalise to a URI. */
export function toUri(fileOrUri: string): string {
    return fileOrUri.startsWith('file://') ? fileOrUri : pathToUri(fileOrUri)
}

/** 1-based CaaS SourceSpan → 0-based LSP Range. */
export function spanToRange(span: SourceSpan): Range {
    const line = Math.max(0, span.line - 1)
    const col = Math.max(0, span.col - 1)
    const len = Math.max(0, span.length)
    return {
        start: { line, character: col },
        end: { line, character: col + len },
    }
}

/** 1-based CaaS SourceRange → 0-based LSP Range. */
export function sourceRangeToRange(r: SourceRange): Range {
    return {
        start: { line: Math.max(0, r.startLine - 1), character: Math.max(0, r.startCol - 1) },
        end: { line: Math.max(0, r.endLine - 1), character: Math.max(0, r.endCol - 1) },
    }
}

/** CaaS SourceSpan → LSP Location (cross-file aware). */
export function spanToLocation(span: SourceSpan): Location {
    return { uri: toUri(span.file), range: spanToRange(span) }
}

/** LSP 0-based position → CaaS 1-based (line, col). */
export function posToCaaS(pos: { line: number; character: number }): { line: number; col: number } {
    return { line: pos.line + 1, col: pos.character + 1 }
}

export function severityFor(d: SiliconDiag): DiagnosticSeverity {
    if (d.code.startsWith('W')) return DiagnosticSeverity.Warning
    return DiagnosticSeverity.Error
}

export function toLspDiagnostic(d: SiliconDiag) {
    return {
        range: spanToRange(d.span),
        severity: severityFor(d),
        code: d.code,
        source: `silicon.${d.phase}`,
        message: d.hint ? `${d.message}\n${d.hint}` : d.message,
    }
}

/** CaaS symbol kind → LSP DocumentSymbol/SymbolInformation kind. */
export function symbolKindToLsp(kind: CaaSSymbolKind): LspSymbolKind {
    switch (kind) {
        case 'function': return LspSymbolKind.Function
        case 'variable': return LspSymbolKind.Variable
        case 'type': return LspSymbolKind.Class
        case 'parameter': return LspSymbolKind.Variable
        case 'stratum': return LspSymbolKind.Operator
        default: return LspSymbolKind.Variable
    }
}

/** CaaS completion-item kind → LSP CompletionItemKind. */
export function completionKindToLsp(kind: CaaSCompletionItem['kind']): CompletionItemKind {
    switch (kind) {
        case 'function': return CompletionItemKind.Function
        case 'variable': return CompletionItemKind.Variable
        case 'type': return CompletionItemKind.Class
        case 'parameter': return CompletionItemKind.Variable
        case 'keyword': return CompletionItemKind.Keyword
        default: return CompletionItemKind.Text
    }
}

/** Semantic-token type legend (index === the token-type id used in the encoding). */
export const SEMANTIC_TOKEN_TYPES: string[] = [
    SemanticTokenTypes.function,
    SemanticTokenTypes.variable,
    SemanticTokenTypes.type,
    SemanticTokenTypes.parameter,
    SemanticTokenTypes.keyword,
]

/** Map a CaaS symbol kind to an index into SEMANTIC_TOKEN_TYPES. */
export function semanticTokenTypeId(kind: CaaSSymbolKind): number {
    switch (kind) {
        case 'function': return 0
        case 'variable': return 1
        case 'type': return 2
        case 'parameter': return 3
        case 'stratum': return 4
        default: return 1
    }
}

/** Build a hover markdown block from a signature + optional doc/container. */
export function hoverMarkdown(signature: string, doc?: string): string {
    const body = ['```silicon', signature, '```']
    if (doc) body.push('', doc)
    return body.join('\n')
}
