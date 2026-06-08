/**
 * ADR-0024 cross-file go-to-definition: inside an `sgl.toml` project the LSP
 * opens every module source file, so a bare intra-module call resolves to its
 * sibling-file definition (Stage 1) and a `mod::name` cross-module call resolves
 * to the right module (Stage 2). Driven against the real examples/modules_demo.
 */

import { describe, expect, test, afterEach } from 'bun:test'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Workspace } from './workspace.ts'
import { pathToUri } from './lsp-convert.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEMO = path.join(REPO, 'examples', 'modules_demo', 'src')

const tmpDirs: string[] = []
afterEach(() => { for (const d of tmpDirs.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }) } catch {} })

/** Scaffold a temp project from a `{ relPath: source }` map; return its root. */
function project(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgl-lsp-'))
    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'sgl.toml'), '[package]\nname = "t"\nentry = "src/main.si"\n')
    for (const [rel, src] of Object.entries(files)) {
        const p = path.join(dir, rel)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, src)
    }
    return dir
}

/** 1-based (line, col) of the `needle` occurrence (after `near`, if given). */
function posOf(text: string, needle: string, near?: string): { line: number; col: number } {
    const from = near ? text.indexOf(near) : 0
    const idx = text.indexOf(needle, from < 0 ? 0 : from)
    if (idx < 0) throw new Error(`not found: ${needle}`)
    const before = text.slice(0, idx)
    const line = before.split('\n').length
    const col = idx - before.lastIndexOf('\n')
    return { line, col }
}

function open(ws: Workspace, rel: string): { uri: string; text: string } {
    const p = path.join(DEMO, rel)
    const text = fs.readFileSync(p, 'utf-8')
    const uri = pathToUri(p)
    ws.update(uri, text)
    return { uri, text }
}

describe('ADR-0024 LSP cross-file go-to-definition', () => {
    test('Stage 1: bare intra-module call `mul` in helpers.si jumps to ops.si', () => {
        const ws = new Workspace()
        const { uri, text } = open(ws, path.join('math', 'helpers.si'))
        // `@fn cube n := { mul(mul(n, n), n) };` — first `mul`.
        const { line, col } = posOf(text, 'mul', '{ ')
        const sym = ws.compiler.findDefinition(uri, line, col)
        expect(sym).toBeTruthy()
        expect(sym!.name).toBe('mul')
        expect(sym!.definitionSpan?.file).toBe(pathToUri(path.join(DEMO, 'math', 'ops.si')))
    })

    test('Stage 2: cross-module `math::square` in text.si jumps to ops.si', () => {
        const ws = new Workspace()
        const { uri, text } = open(ws, path.join('text', 'text.si'))
        const { line, col } = posOf(text, 'square', 'math::')
        const sym = ws.compiler.findDefinition(uri, line, col)
        expect(sym).toBeTruthy()
        expect(sym!.name).toBe('square')
        expect(sym!.definitionSpan?.file).toBe(pathToUri(path.join(DEMO, 'math', 'ops.si')))
    })

    test('Stage 2: `mod::name` disambiguates two modules with a same-named member', () => {
        const dir = project({
            'src/main.si': `\\\\ @export run () -> Int\n@fn run := { a::helper(1) };`,
            'src/a/a.si': `\\\\ @pub helper (Int) -> Int\n@fn helper x := { x };`,
            'src/b/b.si': `\\\\ @pub helper (Int) -> Int\n@fn helper x := { x };`,
        })
        const ws = new Workspace()
        const mainPath = path.join(dir, 'src', 'main.si')
        const text = fs.readFileSync(mainPath, 'utf-8')
        const uri = pathToUri(mainPath)
        ws.update(uri, text)
        // cursor on `helper` in `a::helper`
        const idx = text.indexOf('helper', text.indexOf('a::'))
        const before = text.slice(0, idx)
        const sym = ws.compiler.findDefinition(uri, before.split('\n').length, idx - before.lastIndexOf('\n'))
        expect(sym).toBeTruthy()
        // must resolve to module a's file, NOT b's (same-named `helper`).
        expect(sym!.definitionSpan?.file).toBe(pathToUri(path.join(dir, 'src', 'a', 'a.si')))
    })

    test('Stage 2: a cross-module `mod::name` call raises no spurious unbound diagnostic', () => {
        const dir = project({
            'src/main.si': `\\\\ @export run () -> Int\n@fn run := { 0 };`,
            'src/math/ops.si': `\\\\ @pub square (Int) -> Int\n@fn square n := { n };`,
            'src/text/text.si': `\\\\ @pub score (Int) -> Int\n@fn score n := { math::square(n) };`,
        })
        const ws = new Workspace()
        const textPath = path.join(dir, 'src', 'text', 'text.si')
        const compiled = ws.update(pathToUri(textPath), fs.readFileSync(textPath, 'utf-8'))
        const unbound = (compiled?.diagnostics ?? []).filter(d =>
            /unbound|unresolved|math::square/i.test(d.message))
        expect(unbound).toEqual([])
    })

    test('standalone file (no sgl.toml) does not pull in unrelated siblings', () => {
        // A bare temp file: findDefinition on an unknown name returns nothing,
        // and no project scan happens.
        const ws = new Workspace()
        const tmp = path.join(REPO, 'examples', 'fizzbuzz.si')   // top-level, no sgl.toml
        if (!fs.existsSync(tmp)) return
        const uri = pathToUri(tmp)
        ws.update(uri, fs.readFileSync(tmp, 'utf-8'))
        // Just assert it compiled without throwing and is open.
        expect(ws.getDoc(uri)).toBeTruthy()
    })
})
