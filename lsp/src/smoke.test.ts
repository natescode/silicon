/**
 * Wraps the standalone _smoke-run.ts script as a bun test.  The script
 * spawns the LSP server itself and walks initialize → didOpen → symbols
 * → definition → hover; this test just runs it and asserts the output
 * contains what we expect.
 *
 * Wrapping rather than embedding the spawn here because bun:test holds
 * the process open if a child process or stdin pipe is still alive —
 * the standalone script can call process.exit() explicitly.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// lsp/src/smoke.test.ts → the @silicon/lsp package root is one level up.
const PROJECT_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..',
)

describe('Silicon LSP — v1 alpha', () => {
    test('initialize + open + symbols + definition + hover', () => {
        const r = spawnSync(
            'bun', ['run', path.join('src', '_smoke-run.ts')],
            { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 30_000 },
        )
        expect(r.status).toBe(0)
        const out = r.stdout

        // The script prints a summary the test can match against.
        expect(out).toContain('got ')
        expect(out).toContain('id=1 result')   // initialize
        expect(out).toContain('id=2 result')   // documentSymbol
        expect(out).toContain('id=3 result')   // definition
        expect(out).toContain('id=4 result')   // hover

        // Capability check: server advertises the four v1 providers.
        expect(out).toContain('documentSymbolProvider":true')
        expect(out).toContain('definitionProvider":true')
        expect(out).toContain('hoverProvider":true')

        // Symbol index returned `add` with a non-zero selectionRange.
        expect(out).toMatch(/"name":"add".*"selectionRange":\{"start":\{"line":0,"character":[1-9]/)

        // Hover markdown mentions @fn keyword.
        expect(out).toContain('@fn')
    }, 30_000)
})
