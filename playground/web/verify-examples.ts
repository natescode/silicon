// SPDX-License-Identifier: MIT
/**
 * Compile EVERY example program shown in the playground (the `EXAMPLES` object
 * in playground/index.html) through the exact in-browser compile path, and
 * assert each one compiles cleanly. Catches stale/legacy example source after a
 * grammar change.
 *
 *   bun run playground/web/verify-examples.ts
 */
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { readFileSync } from 'fs'
import type { BunPlugin } from 'bun'

const WEB = dirname(fileURLToPath(import.meta.url))
const BROWSER_SOURCES = /[\\/](strataSource|stdWatSource|moduleSources|platformSource)$/
const DISALLOWED = /^(node:)?(fs|path|url|os|child_process|crypto)$|^binaryen$/

const browserSwap: BunPlugin = {
    name: 'browser-source-swap',
    setup(build) {
        build.onResolve({ filter: BROWSER_SOURCES }, args => ({
            path: join(dirname(args.importer), args.path + '.browser.ts'),
        }))
        build.onResolve({ filter: DISALLOWED }, args => ({
            errors: [{ text: `Disallowed dependency "${args.path}" reached the browser bundle (via ${args.importer}).` }],
        }))
    },
}

// ── extract the EXAMPLES object literal from index.html ─────────────────────
const html = readFileSync(join(WEB, '..', 'playground', 'index.html'), 'utf8')
const start = html.indexOf('const EXAMPLES = {')
if (start < 0) throw new Error('EXAMPLES object not found in index.html')
// find the matching closing brace of the object literal
let i = html.indexOf('{', start), depth = 0, end = -1, inStr = '', esc = false
for (; i < html.length; i++) {
    const c = html[i]
    if (inStr) {
        if (esc) { esc = false; continue }
        if (c === '\\') { esc = true; continue }
        if (c === inStr) inStr = ''
        continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
}
if (end < 0) throw new Error('could not balance EXAMPLES object braces')
const objText = html.slice(html.indexOf('{', start), end + 1)
// eslint-disable-next-line no-eval
const EXAMPLES: Record<string, string> = eval('(' + objText + ')')

// ── bundle entry.ts (browser target) exactly like verify.ts ─────────────────
const outdir = join(tmpdir(), 'silicon-playground-verify-examples')
const result = await Bun.build({
    entrypoints: [join(WEB, 'entry.ts')], target: 'browser', outdir,
    external: ['wabt'], plugins: [browserSwap],
})
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1) }
await import(result.outputs[0].path)
const SiliconCompiler = (globalThis as any).SiliconCompiler as {
    compile(req: { source: string; platform?: string; features?: string[] }): Promise<any>
}
if (!SiliconCompiler) throw new Error('globalThis.SiliconCompiler was not set by the bundle')

// ── compile every non-empty example ─────────────────────────────────────────
let failed = 0, ok = 0
for (const [name, source] of Object.entries(EXAMPLES)) {
    if (!source.trim()) continue
    const data = await SiliconCompiler.compile({ source, platform: 'web', features: [] })
    if (data.success) {
        ok++
        console.log(`✓ ${name} — ${data.exports.length} export(s)`)
    } else {
        failed++
        console.error(`✗ ${name} FAILED:\n${(data.error || '').split('\n').map((l: string) => '    ' + l).join('\n')}`)
    }
}
console.log(`\nEXAMPLES: ${ok} compiled, ${failed} failed`)
if (failed) process.exit(1)
console.log('PLAYGROUND EXAMPLES VERIFY: PASS')
