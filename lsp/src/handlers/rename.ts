import type { Connection, TextDocuments, WorkspaceEdit, TextEdit, Range } from 'vscode-languageserver/node.js'
import { ResponseError, ErrorCodes } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS, spanToRange, toUri } from '../lsp-convert.ts'

/** Identifier characters Silicon allows in a name. */
const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch)

/** The [start,end) range of the identifier under `position`, or null if the
 *  cursor isn't on an identifier. */
function identRangeAt(doc: TextDocument, position: { line: number; character: number }): Range | null {
    const lineText = doc.getText({
        start: { line: position.line, character: 0 },
        end:   { line: position.line, character: Number.MAX_SAFE_INTEGER },
    })
    let s = position.character
    let e = position.character
    while (s > 0 && isIdentChar(lineText[s - 1] ?? '')) s--
    while (e < lineText.length && isIdentChar(lineText[e] ?? '')) e++
    if (e === s) return null
    return { start: { line: position.line, character: s }, end: { line: position.line, character: e } }
}

export function registerRename(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    // `textDocument/prepareRename` — validate the cursor sits on a renameable,
    // user-written symbol BEFORE the editor prompts for a new name.  Rejects
    // keywords/strata and compiler-synthesized symbols; returns the identifier
    // range the editor pre-fills.
    connection.onPrepareRename(({ textDocument, position }): Range | null => {
        if (!documents.get(textDocument.uri)) return null
        const { line, col } = posToCaaS(position)
        const sym = workspace.compiler.findDefinition(textDocument.uri, line, col)
        if (!sym || sym.isImplicitlyDeclared || sym.kind === 'stratum') {
            throw new ResponseError(ErrorCodes.InvalidRequest, 'This element cannot be renamed.')
        }
        const range = identRangeAt(documents.get(textDocument.uri)!, position)
        if (!range) throw new ResponseError(ErrorCodes.InvalidRequest, 'No renameable identifier here.')
        return range
    })

    connection.onRenameRequest(({ textDocument, position, newName }): WorkspaceEdit | null => {
        if (!documents.get(textDocument.uri)) return null
        const { line, col } = posToCaaS(position)
        const edit = workspace.compiler.rename(textDocument.uri, line, col, newName)
        if (edit.changeCount === 0) return null

        const changes: Record<string, TextEdit[]> = {}
        for (const [file, edits] of edit) {
            changes[toUri(file)] = edits.map(e => ({
                range: spanToRange(e.span),
                newText: e.newText,
            }))
        }
        return { changes }
    })
}
