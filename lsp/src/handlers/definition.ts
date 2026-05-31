import type { Connection, TextDocuments, Position } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'

export function registerDefinition(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onDefinition(({ textDocument, position }) => {
        const doc = documents.get(textDocument.uri)
        if (!doc) return null

        const name = identifierAt(doc, position)
        if (!name) return null

        const symbol = workspace.resolveSymbol(textDocument.uri, name)
        if (!symbol) return null

        return { uri: symbol.uri, range: symbol.selectionRange }
    })
}

/**
 * Extract the identifier under (or immediately adjacent to) the cursor.
 *
 * Recognises Silicon names that may include namespace separators
 * (Module::fn or a.b.c).  Returns the LAST segment for cross-file
 * resolution — `Module::fn` → "fn".  This is sufficient for v1; full
 * multi-segment resolution lands in a later slice once strata-aware
 * navigation is on the table.
 */
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

    // Walk leftward for a `::` prefix chain; we only care about the
    // last segment for symbol lookup.
    while (start >= 2 && line.slice(start - 2, start) === '::') {
        let prev = start - 2
        while (prev > 0 && isWord(line[prev - 1])) prev--
        start = prev
    }
    const full = line.slice(start, end)

    // The user may have clicked on the namespace prefix itself.  In that
    // case we want the prefix, not the trailing segment.
    if (start + word.length <= ch + word.length && line.slice(start, ch + word.length).includes('::')) {
        // Take the segment containing the cursor.
        const segments = full.split('::')
        let offset = start
        for (const seg of segments) {
            if (ch >= offset && ch <= offset + seg.length) return seg
            offset += seg.length + 2  // segment + '::'
        }
    }

    // Strip a leading '&' (call sigil) or '@' (keyword) from the segment
    // so the lookup matches the declaration's bare name.
    word = full.split('::').pop() ?? full
    if (word.startsWith('&')) word = word.slice(1)
    return word || undefined
}
