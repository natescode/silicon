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

// ── extract object literals from index.html ─────────────────────────────────
const html = readFileSync(join(WEB, '..', 'playground', 'index.html'), 'utf8')

/** Balance-match the `{ … }` object literal that follows `marker` and eval it. */
function extractObject<T>(marker: string, required = true): T {
    const start = html.indexOf(marker)
    if (start < 0) { if (required) throw new Error(`${marker} not found in index.html`); return {} as T }
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
    if (end < 0) throw new Error(`could not balance ${marker} braces`)
    // eslint-disable-next-line no-eval
    return eval('(' + html.slice(html.indexOf('{', start), end + 1) + ')')
}

const EXAMPLES = extractObject<Record<string, string>>('const EXAMPLES = {')
const EXAMPLE_FEATURES = extractObject<Record<string, string[]>>('const EXAMPLE_FEATURES = {')
const EXAMPLE_TARGETS = extractObject<Record<string, string>>('const EXAMPLE_TARGETS = {')

// Mirror index.html's example-picker: resolve the exact features + target each
// example is compiled with in the UI, so this check matches real playground use.
const VALID_FEATURES = new Set(['canvas', 'game', 'dom'])
function featuresFor(key: string, src: string): string[] {
    let feats: string[]
    if (key in EXAMPLE_FEATURES) feats = EXAMPLE_FEATURES[key]
    else if (key === 'empty') feats = []
    else {
        feats = []
        if (src.includes('canvas_')) feats.push('canvas')
        if (src.includes('@export tick')) feats.push('game')
        if (src.includes('set_html')) feats.push('dom')
    }
    return feats.filter(f => VALID_FEATURES.has(f))
}

// ── bundle entry.ts (browser target) exactly like verify.ts ─────────────────
const outdir = join(tmpdir(), 'silicon-playground-verify-examples')
const result = await Bun.build({
    entrypoints: [join(WEB, 'entry.ts')], target: 'browser', outdir,
    external: ['wabt'], plugins: [browserSwap],
})
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1) }
await import(result.outputs[0].path)
const SiliconCompiler = (globalThis as any).SiliconCompiler as {
    compile(req: { source: string; platform?: string; features?: string[]; target?: string }): Promise<any>
}
if (!SiliconCompiler) throw new Error('globalThis.SiliconCompiler was not set by the bundle')

// ── compile every non-empty example with its real features + target ──────────
let failed = 0, ok = 0
for (const [name, source] of Object.entries(EXAMPLES)) {
    if (!source.trim()) continue
    const features = featuresFor(name, source)
    const target = EXAMPLE_TARGETS[name] ?? 'host'
    const data = await SiliconCompiler.compile({ source, platform: 'web', features, target })
    const tag = `[${features.join(',') || 'core'}${target !== 'host' ? ` · ${target}` : ''}]`
    if (data.success) {
        ok++
        console.log(`✓ ${name} ${tag} — ${data.exports.length} export(s)`)
    } else {
        failed++
        console.error(`✗ ${name} ${tag} FAILED:\n${(data.error || '').split('\n').map((l: string) => '    ' + l).join('\n')}`)
    }
}
console.log(`\nEXAMPLES: ${ok} compiled, ${failed} failed`)
if (failed) process.exit(1)
console.log('PLAYGROUND EXAMPLES VERIFY: PASS')
