#!/usr/bin/env bun
// One-shot smoke runner — bypasses bun:test framework.
// Spawns the LSP, walks initialize → didOpen → 3 LSP requests, prints results.
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const child = spawn('bun', ['run', path.join(here, 'index.ts')],
    { stdio: ['pipe', 'pipe', 'pipe'] })

child.stderr.on('data', (d) => process.stderr.write(`[lsp] ${d}`))

let buf = Buffer.alloc(0)
const messages: any[] = []
child.stdout.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    while (true) {
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) return
        const m = buf.subarray(0, i).toString().match(/Content-Length:\s*(\d+)/i)
        if (!m) return
        const len = +m[1]
        const start = i + 4
        if (buf.length < start + len) return
        try { messages.push(JSON.parse(buf.subarray(start, start + len).toString())) } catch {}
        buf = buf.subarray(start + len)
    }
})

const send = (msg: any) => {
    const body = JSON.stringify(msg)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

const sample = `\\\\ add (Int, Int) -> Int
@fn add a, b := { a + b };

@fn main := { &add 20, 22 };
`
const uri = pathToFileURL(path.resolve(here, '..', '_sample.si')).href
let id = 1
send({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { capabilities: {} } })
send({ jsonrpc: '2.0', method: 'initialized', params: {} })
send({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'silicon', version: 1, text: sample } },
})
await new Promise(r => setTimeout(r, 600))
send({
    jsonrpc: '2.0', id: id++, method: 'textDocument/documentSymbol',
    params: { textDocument: { uri } },
})
send({
    jsonrpc: '2.0', id: id++, method: 'textDocument/definition',
    params: { textDocument: { uri }, position: { line: 3, character: 16 } },
})
send({
    jsonrpc: '2.0', id: id++, method: 'textDocument/hover',
    params: { textDocument: { uri }, position: { line: 3, character: 16 } },
})
await new Promise(r => setTimeout(r, 800))

console.log(`got ${messages.length} messages`)
for (const m of messages) {
    if (m.method === 'textDocument/publishDiagnostics') {
        console.log(`  diagnostics: ${(m.params.diagnostics ?? []).length} entry/ies`)
    } else if (typeof m.id === 'number') {
        const tag = JSON.stringify(m.result).slice(0, 400)
        console.log(`  id=${m.id} result: ${tag}`)
    }
}
child.kill()
process.exit(0)
