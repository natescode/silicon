#!/usr/bin/env bun
/**
 * Smoke test for the BUNDLED server (lsp/dist/index.js) — confirms the
 * VSIX-shipped artifact responds to initialize + didOpen + the four
 * v1 alpha requests when spawned under `node`.  Mirrors the dev-mode
 * smoke at lsp/src/_smoke-run.ts but targets the production bundle.
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.resolve(here, '..', 'lsp', 'dist', 'index.js')
const child = spawn('node', [bundle, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })

child.stderr.on('data', d => process.stderr.write(`[lsp] ${d}`))

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

function send(obj: any): void {
    const body = JSON.stringify(obj)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
    const t0 = Date.now()
    while (!predicate()) {
        if (Date.now() - t0 > ms) throw new Error('timeout')
        await new Promise(r => setTimeout(r, 50))
    }
}

(async () => {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: null, capabilities: {} } })
    await waitFor(() => messages.some(m => m.id === 1 && m.result))
    send({ jsonrpc: '2.0', method: 'initialized', params: {} })

    const uri = pathToFileURL(path.resolve(here, 'demo.si')).href
    send({
        jsonrpc: '2.0', method: 'textDocument/didOpen',
        params: {
            textDocument: {
                uri, languageId: 'silicon', version: 1,
                text: '@fn add a:Int, b:Int := { (a + b) };\n',
            },
        },
    })

    send({ jsonrpc: '2.0', id: 2, method: 'textDocument/documentSymbol', params: { textDocument: { uri } } })
    send({ jsonrpc: '2.0', id: 3, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 0, character: 32 } } })
    send({ jsonrpc: '2.0', id: 4, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 5 } } })

    await waitFor(() => messages.filter(m => m.id && m.result !== undefined).length >= 4)

    for (const m of messages) {
        if (m.id) console.log(`got id=${m.id} result`, JSON.stringify(m.result).slice(0, 120))
    }
    const init = messages.find(m => m.id === 1)?.result
    console.log('documentSymbolProvider":' + Boolean(init?.capabilities?.documentSymbolProvider))
    console.log('definitionProvider":' + Boolean(init?.capabilities?.definitionProvider))
    console.log('hoverProvider":' + Boolean(init?.capabilities?.hoverProvider))

    child.kill()
    process.exit(0)
})().catch(e => { console.error(e); child.kill(); process.exit(1) })
