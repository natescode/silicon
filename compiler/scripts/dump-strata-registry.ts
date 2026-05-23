#!/usr/bin/env bun
// Stage 0 reference dumper: builds the strata registry from the same
// built-in source bundle the Silicon loader sees, then emits a JSON
// document with the SAME shape (sorted, deduped, no typed variants)
// as boot/strata/registry_json.si.  Used by the Phase 3 gate test.

import { buildStrataRegistry } from '../src/elaborator/strataLoader'
import type { Program } from '../src/ast/astNodes'

// Build the registry with an empty user AST — only the built-in
// src/strata/*.si bundle is loaded.
const emptyProgram: Program = { type: 'Program', elements: [] } as any
const reg = buildStrataRegistry(emptyProgram)

// Drop typed-variant keys (anything containing ':').  The Silicon
// loader doesn't synthesize typed variants yet (no body interpreter
// in Phase 3) so we compare bare symbols only.
function bareKeys(table: Record<string, unknown>): string[] {
    const seen = new Set<string>()
    for (const k of Object.keys(table)) {
        const bare = k.includes(':') ? k.slice(0, k.indexOf(':')) : k
        seen.add(bare)
    }
    return Array.from(seen).sort()
}

const operators = bareKeys(reg.operators)
const keywords  = bareKeys(reg.keywords)

const defKindsSorted: Record<string, string> = {}
for (const kw of Object.keys(reg.defKinds).sort()) {
    defKindsSorted[kw] = reg.defKinds[kw].codegenKind
}

// Match Silicon's exact whitespace: 2-space indent, key: value with
// a space, trailing newline.  Hand-format so the output is byte-equal
// to what the Silicon program emits — not what JSON.stringify produces.
function emit(): string {
    const lines: string[] = []
    lines.push('{')
    // operators
    if (operators.length === 0) {
        lines.push('  "operators": [],')
    } else {
        lines.push('  "operators": [')
        operators.forEach((s, i) => {
            lines.push(`    "${s}"${i < operators.length - 1 ? ',' : ''}`)
        })
        lines.push('  ],')
    }
    // keywords
    if (keywords.length === 0) {
        lines.push('  "keywords": [],')
    } else {
        lines.push('  "keywords": [')
        keywords.forEach((s, i) => {
            lines.push(`    "${s}"${i < keywords.length - 1 ? ',' : ''}`)
        })
        lines.push('  ],')
    }
    // defKinds
    const dkKeys = Object.keys(defKindsSorted)
    if (dkKeys.length === 0) {
        lines.push('  "defKinds": {}')
    } else {
        lines.push('  "defKinds": {')
        dkKeys.forEach((kw, i) => {
            const cg = defKindsSorted[kw]
            lines.push(`    "${kw}": "${cg}"${i < dkKeys.length - 1 ? ',' : ''}`)
        })
        lines.push('  }')
    }
    lines.push('}')
    return lines.join('\n') + '\n'
}

process.stdout.write(emit())
