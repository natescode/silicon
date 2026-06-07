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
const TARGETS: Record<string, string> = (() => {
    try { return extractObject('const EXAMPLE_TARGETS = {') } catch { return {} }
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
            const target = TARGETS[name] ?? 'host'
            const r = await page.evaluate(async ({ src, features, target }) => {
                try {
                    const x = await (window as any).SiliconCompiler.compile({ source: src, platform: 'web', features, target })
                    return x.success ? null : (x.error?.split('\n')[0] ?? 'compile failed')
                } catch (e) {
                    return e instanceof Error ? e.message : String(e)
                }
            }, { src, features, target })
            const label = target !== 'host' ? `${name} [${target}]` : name
            if (r) { failed++; console.error(`✗ ${label}: ${r}`) }
            else { pass++; console.log(`✓ ${label}`) }
        }
        console.log(`\n${pass} example(s) compiled in Chromium, ${failed} failed.`)

        // Run a program end-to-end and check console output decodes correctly
        // (guards the UTF-8 string encoding — a UTF-16 mismatch garbles output).
        const printed = await page.evaluate(async () => {
            const src = "@fn run := { web::console_log_str('Hello, Silicon!') };\n@export run;"
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

        // ── Drive the real UI for every example ──────────────────────────────
        // Selects each example from the dropdown (which sets its platform
        // features), enables "run main", compiles, and calls every export with
        // valid args — exercising the actual compile→instantiate→run path in
        // index.html (the `{ builtins: 'js-string' }` Module-instantiate path
        // the bytes-only check above never touches).  Catches the
        // "wasmInstance undefined" and feature-default classes of bug.
        console.log('\nRunning every example through the UI:')
        await page.evaluate(() => {
            const cb = document.getElementById('run-main-checkbox') as HTMLInputElement | null
            if (cb && !cb.checked) cb.click()
        })
        const exampleKeys: string[] = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#example-select option'))
                .map(o => (o as HTMLOptionElement).value)
                .filter(v => v && v !== 'empty'))
        let ranOk = 0
        for (const key of exampleKeys) {
            await page.evaluate(k => {
                const s = document.getElementById('example-select') as HTMLSelectElement
                s.value = k; s.dispatchEvent(new Event('change'))
            }, key)
            await page.waitForTimeout(80)
            await page.evaluate(() => (document.getElementById('btn-clear-console') as HTMLButtonElement | null)?.click())
            const before = pageErrors.length
            await page.click('#btn-compile')
            await page.waitForTimeout(700)
            const nrows: number = await page.evaluate(() => document.querySelectorAll('#exports-panel .export-row').length)
            for (let i = 0; i < nrows; i++) {
                await page.evaluate(j => {
                    const row = document.querySelectorAll('#exports-panel .export-row')[j]
                    if (!row) return
                    row.querySelectorAll('.param-input').forEach(el => {
                        const inp = el as HTMLInputElement
                        const ph = inp.placeholder || ''
                        inp.value = ph.toLowerCase().includes('string') ? 'hi' : ph === '0.0' ? '2.0' : '3'
                    })
                    ;(row.querySelector('.btn-call') as HTMLButtonElement | null)?.click()
                }, i)
                await page.waitForTimeout(50)
            }
            await page.waitForTimeout(120)
            const banner: string = await page.evaluate(() => {
                const e = document.getElementById('error-banner') as HTMLElement
                return e && e.style.display !== 'none' ? e.textContent || '' : ''
            })
            const errLines: string[] = await page.evaluate(() =>
                Array.from(document.querySelectorAll('#console .console-line.err, #console .console-line.error'))
                    .map(l => l.textContent || ''))
            const newPageErrs = pageErrors.slice(before)
            if (banner || errLines.length || newPageErrs.length) {
                failed++
                console.error(`✗ run ${key}: ${[banner, ...errLines, ...newPageErrs].filter(Boolean).join(' | ')}`)
            } else {
                ranOk++
                console.log(`✓ run ${key}`)
            }
        }
        console.log(`\n${ranOk}/${exampleKeys.length} example(s) ran without errors in the UI.`)
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
