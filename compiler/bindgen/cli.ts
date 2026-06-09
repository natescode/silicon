// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — bindgen CLI.  Generates the Web Math/clock surface and splices it
 * into the three hand-maintained-until-now sites between marker comments:
 *
 *   1. compiler/src/strata/modules/web.si       (the `.si` @extern block)
 *   2. cli/src/host/js-host.ts                  (the Bun host shim)
 *   3. playground/playground/web-env.js         (the browser host shim)
 *
 *   bun bindgen/cli.ts            # --check (default): exit 1 if any site has drifted
 *   bun bindgen/cli.ts --write    # rewrite the three sites in place
 *
 * Run from the `compiler/` directory.  The marker comments are inserted once by
 * hand; thereafter this tool owns the bytes between them.
 */

import { readFileSync, writeFileSync } from 'fs'
import { WEB_MATH_CLOCK, WEB_MODULE } from './src/spec'
import { generate } from './src/generate'

const START = 'bindgen:web math+clock'
const END = '/bindgen:web math+clock'

interface Target {
    readonly label: string
    readonly path: string
    readonly fragment: string
}

/** Replace the lines strictly between the START and END marker lines with
 *  `fragment`.  Returns the rewritten file text, or throws if markers are
 *  missing / malformed. */
function splice(text: string, fragment: string, path: string): string {
    const lines = text.split('\n')
    const startIdx = lines.findIndex(l => l.includes(START) && !l.includes(END))
    const endIdx = lines.findIndex(l => l.includes(END))
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        throw new Error(`${path}: bindgen markers not found (expected '${START}' … '${END}')`)
    }
    return [...lines.slice(0, startIdx + 1), fragment, ...lines.slice(endIdx)].join('\n')
}

/** Extract the current bytes between the markers (for --check). */
function extract(text: string, path: string): string {
    const lines = text.split('\n')
    const startIdx = lines.findIndex(l => l.includes(START) && !l.includes(END))
    const endIdx = lines.findIndex(l => l.includes(END))
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        throw new Error(`${path}: bindgen markers not found`)
    }
    return lines.slice(startIdx + 1, endIdx).join('\n')
}

export function targets(): Target[] {
    const g = generate(WEB_MODULE, WEB_MATH_CLOCK)
    return [
        { label: '.si @extern', path: 'src/strata/modules/web.si',            fragment: g.si },
        { label: 'Bun shim',    path: '../cli/src/host/js-host.ts',           fragment: g.bunShim },
        { label: 'browser shim', path: '../playground/playground/web-env.js', fragment: g.webShim },
    ]
}

/** `--report`: run every source adapter against its real spec and print the
 *  per-source coverage (auto-generated Tier-0 bindings + what was skipped). */
function report(): void {
    const { webrefToSpecs } = require('./src/adapters/webref') as typeof import('./src/adapters/webref')
    const { dtsToSpecs } = require('./src/adapters/dts') as typeof import('./src/adapters/dts')
    const { MATH_DATE_COUNT } = require('./src/spec') as any

    const web = webrefToSpecs()
    const node = dtsToSpecs({ module: 'node:path', types: ['node'], accessor: "require('node:path')", prefix: 'path' })
    const bun = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: 'bun' })

    console.log('FFI binding sources — auto-generated from spec (ADR 0017):\n')
    const row = (src: string, spec: string, gen: number, skip: number) =>
        console.log(`  ${src.padEnd(12)} ${spec.padEnd(22)} ${String(gen).padStart(4)} bindings   ${skip} skipped (non-Tier-0)`)
    row('Web IDL', '@webref/idl corpus', web.specs.length, web.skipped.length)
    row('Node', '@types/node (.d.ts)', node.specs.length, node.skipped.length)
    row('Bun', 'bun-types (.d.ts)', bun.specs.length, bun.skipped.length)
    console.log(`  ${'ECMAScript'.padEnd(12)} ${'(hand-authored)'.padEnd(22)} ${String(MATH_DATE_COUNT ?? 16).padStart(4)} bindings   — Math/Date have no machine-readable spec`)
    console.log('\n  Web IDL gives int-vs-float exactly; Node/Bun use the TS `number` heuristic (default Float).')
    console.log('  The signature + tier come from the spec; the host accessor (e.g. `performance`, `Bun`) is the per-source convention.')
}

function main(): void {
    if (process.argv.includes('--report')) { report(); return }
    const write = process.argv.includes('--write')
    let drift = 0
    for (const t of targets()) {
        const text = readFileSync(t.path, 'utf8')
        if (write) {
            const next = splice(text, t.fragment, t.path)
            if (next !== text) { writeFileSync(t.path, next); console.log(`wrote  ${t.label}  (${t.path})`) }
            else console.log(`ok     ${t.label}  (unchanged)`)
        } else {
            const current = extract(text, t.path)
            if (current === t.fragment) console.log(`ok     ${t.label}`)
            else { drift++; console.log(`DRIFT  ${t.label}  (${t.path}) — run \`bun bindgen/cli.ts --write\``) }
        }
    }
    if (!write && drift > 0) {
        console.error(`\n${drift} site(s) drifted from the bindgen spec.`)
        process.exit(1)
    }
}

if (import.meta.main) main()
