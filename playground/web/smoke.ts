// SPDX-License-Identifier: MIT
/**
 * Headless-browser smoke test for the static playground.
 *
 *   bun run --cwd playground smoke           # builds, then runs this
 *   bun run --cwd playground smoke:install   # one-time: fetch the browser
 *
 * Loads the BUILT dist/index.html in real Chromium and compiles every example.
 * This catches browser-only failures that the Bun-based web/verify.ts cannot —
 * Bun has `process`/`Buffer` as globals and no sync-WASM size limit, so things
 * like the `$&` String.replace inlining corruption (→ SiliconCompiler
 * undefined) or `process is not defined` in the comptime engine only show up in
 * an actual browser. Run it before deploying.
 */

import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const WEB = dirname(fileURLToPath(import.meta.url))
const DIST = join(WEB, '..', 'dist', 'index.html')

if (!existsSync(DIST)) {
    console.error(`✗ ${DIST} not found — run \`bun run --cwd playground build\` first.`)
    process.exit(1)
}
const html = readFileSync(DIST, 'utf8')

// Extract the EXAMPLES object literal + per-example features from the built HTML.
function extractObject(marker: string): Record<string, any> {
    const start = html.indexOf(marker)
    if (start < 0) throw new Error(`could not find ${marker} in dist/index.html`)
    const open = html.indexOf('{', start)
    let depth = 0
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth++
        else if (html[i] === '}') { depth--; if (depth === 0) return eval('(' + html.slice(open, i + 1) + ')') }
    }
    throw new Error(`unbalanced braces after ${marker}`)
}
const EXAMPLES: Record<string, string> = extractObject('const EXAMPLES = {')
const FEATURES: Record<string, string[]> = (() => {
    try { return extractObject('const EXAMPLE_FEATURES = {') } catch { return {} }
})()

let browser
try {
    browser = await chromium.launch()
} catch (e) {
    console.error('✗ Could not launch Chromium. Install it once with:\n    bun run --cwd playground smoke:install')
    console.error(String(e instanceof Error ? e.message : e).split('\n')[0])
    process.exit(1)
}

const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) })
const page = await browser.newPage()
const pageErrors: string[] = []
page.on('pageerror', e => pageErrors.push(e.message))
page.on('console', m => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`) })

let failed = 0
try {
    await page.goto(`http://localhost:${server.port}/`, { waitUntil: 'networkidle' })

    // The compiler bundle must have loaded and set the global. A failure here
    // is the inlining-corruption / module-eval class of bug.
    const hasCompiler = await page.evaluate(() => typeof (window as any).SiliconCompiler?.compile === 'function')
    if (!hasCompiler) {
        console.error('✗ window.SiliconCompiler.compile is not available — the bundle failed to load/evaluate.')
        failed++
    } else {
        let pass = 0
        for (const [name, src] of Object.entries(EXAMPLES)) {
            if (!src || !src.trim()) continue
            const features = FEATURES[name] ?? []
            const r = await page.evaluate(async ({ src, features }) => {
                try {
                    const x = await (window as any).SiliconCompiler.compile({ source: src, platform: 'web', features })
                    return x.success ? null : (x.error?.split('\n')[0] ?? 'compile failed')
                } catch (e) {
                    return e instanceof Error ? e.message : String(e)
                }
            }, { src, features })
            if (r) { failed++; console.error(`✗ ${name}: ${r}`) }
            else { pass++; console.log(`✓ ${name}`) }
        }
        console.log(`\n${pass} example(s) compiled in Chromium, ${failed} failed.`)

        // Run a program end-to-end and check console output decodes correctly
        // (guards the UTF-8 string encoding — a UTF-16 mismatch garbles output).
        const printed = await page.evaluate(async () => {
            const src = "@fn run := { &web::console_log_str 'Hello, Silicon!' };\n@export run;"
            const data = await (window as any).SiliconCompiler.compile({ source: src, platform: 'web', features: [] })
            if (!data.success) return { error: data.error }
            const bytes = Uint8Array.from(atob(data.wasm), (c: string) => c.charCodeAt(0))
            const out: string[] = []
            const env = (window as any).createWebEnv({ onPrint: (m: string) => out.push(m) }, [])
            const { instance } = await WebAssembly.instantiate(bytes, env.imports)
            env.bindInstance(instance)
            ;(instance.exports as any).run()
            return { out }
        })
        if ((printed as any).error || (printed as any).out?.[0] !== 'Hello, Silicon!') {
            failed++
            console.error(`✗ console output (encoding): expected "Hello, Silicon!", got ${JSON.stringify(printed)}`)
        } else {
            console.log(`✓ console output decodes as UTF-8: "${(printed as any).out[0]}"`)
        }
    }
} finally {
    await browser.close()
    server.stop()
}

if (pageErrors.length) {
    console.error('\n✗ Uncaught page errors:\n  ' + pageErrors.slice(0, 10).join('\n  '))
    failed++
}

if (failed) { console.error('\nSMOKE: FAIL'); process.exit(1) }
console.log('\nSMOKE: PASS')
