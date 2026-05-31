import type { Connection, TextDocuments, Position } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'

export function registerHover(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onHover(({ textDocument, position }) => {
        const doc = documents.get(textDocument.uri)
        if (!doc) return null

        const name = identifierAt(doc, position)
        if (!name) return null

        const symbol = workspace.resolveSymbol(textDocument.uri, name)
        if (!symbol) return null

        const signature = [symbol.keyword, symbol.name, symbol.typeAnnotation]
            .filter(Boolean).join(' ')
        const body = ['```silicon', signature, '```']
        if (symbol.doc) { body.push('', symbol.doc) }
        if (symbol.container) {
            body.push('', `*in `, '`', symbol.container, '`', '*')
        }
        return {
            contents: { kind: 'markdown', value: body.join('\n') },
            range:    symbol.selectionRange,
        }
    })
}

function identifierAt(doc: TextDocument, pos: Position): string | undefined {
    const line = doc.getText({
        start: { line: pos.line, character: 0 },
        end:   { line: pos.line, character: Number.MAX_SAFE_INTEGER },
    })
    if (!line) return undefined
    const ch = pos.character
    const isWord = (c: string) => /[A-Za-z0-9_@]/.test(c)
    let start = ch
    while (start > 0 && isWord(line[start - 1])) start--
    let end = ch
    while (end < line.length && isWord(line[end])) end++
    if (start === end) return undefined
    let word = line.slice(start, end)
    if (word.startsWith('&')) word = word.slice(1)
    return word || undefined
}
