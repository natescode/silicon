import type { Connection, TextDocuments } from 'vscode-languageserver/node.js'
import { SemanticTokensBuilder } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import type { SourceSpan } from '@silicon/compiler'
import { semanticTokenTypeId } from '../lsp-convert.ts'

interface RawToken { line: number; char: number; length: number; type: number }

export function registerSemanticTokens(
    connection: Connection,
    _documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.languages.semanticTokens.on(({ textDocument }) => {
        const doc = workspace.getDoc(textDocument.uri)
        if (!doc) return { data: [] }

        const toks: RawToken[] = []
        const push = (span: SourceSpan | undefined, type: number) => {
            if (!span || span.length <= 0) return
            // Only tokens that belong to this document; references can be cross-file.
            if (span.file !== textDocument.uri) return
            toks.push({ line: span.line - 1, char: span.col - 1, length: span.length, type })
        }

        for (const sym of doc.model.allSymbols) {
            const type = semanticTokenTypeId(sym.kind)
            push(sym.definitionSpan, type)
            // S1: skip occurrences a shadowing local/param claimed — they are
            // a different binding and must not be colored as this symbol.
            for (const ref of doc.model.unshadowedReferenceSpansForName(sym.name)) push(ref, type)
        }

        // LSP requires tokens emitted in (line, char) order, deduplicated.
        toks.sort((a, b) => a.line - b.line || a.char - b.char)
        const builder = new SemanticTokensBuilder()
        let lastLine = -1, lastChar = -1
        for (const t of toks) {
            if (t.line === lastLine && t.char === lastChar) continue
            builder.push(t.line, t.char, t.length, t.type, 0)
            lastLine = t.line; lastChar = t.char
        }
        return builder.build()
    })
}
