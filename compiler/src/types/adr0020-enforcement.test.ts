// SPDX-License-Identifier: MIT
// ADR 0020: a bare binding is immutable (reassignment is E0007); `@mut` is mutable.
// These drive the full pipeline (parse → elaborate → typecheck) so they exercise the
// parser's `immutable` flag synthesis AND the typechecker's enforcement together.
import { test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas/index'
import { resolveUses } from '../modules/useResolver'
import { loadModules } from '../modules'

const ENTRY = resolve(__dirname, '../../entry.si')

function diagnostics(src: string): string[] {
    const { source } = resolveUses(src, ENTRY, { target: 'host' })
    const reg = loadModules(dirname(ENTRY))
    const result = compile(source, { file: ENTRY, moduleRegistry: reg, target: 'host', emitBinary: false })
    return result.diagnostics.map((d: any) => d.message)
}

const isImmutableErr = (m: string) => /immutable/i.test(m)

test('reassigning a bare (immutable) local is rejected', () => {
    const errs = diagnostics('@fn f := { x := 1; x = 2; x };\n@export f;')
    expect(errs.some(isImmutableErr)).toBe(true)
})

test('reassigning a @mut local is allowed', () => {
    const errs = diagnostics('@fn f := { @mut x := 1; x = 2; x };\n@export f;')
    expect(errs.some(isImmutableErr)).toBe(false)
})

test('a bare local that is never reassigned compiles cleanly', () => {
    const errs = diagnostics('@fn f := { x := 1; x };\n@export f;')
    expect(errs.filter(isImmutableErr)).toEqual([])
})
