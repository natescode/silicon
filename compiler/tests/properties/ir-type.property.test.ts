/**
 * IR Type Coverage Property
 *
 * Every IR expression node should carry a non-'void' wasmType — except for the
 * explicit allow-list of kinds where 'void' is the correct answer (Block trailing
 * a void statement, Return that produces no value, Nop, control flow that never
 * yields, etc).
 *
 * Background: pre-IR, codegen sniffed compiled WAT for "f32.const" to choose
 * between i32 and f32 ops. The IR layer killed that — every expression node
 * now has its wasmType pre-computed from typechecker.inferredType (see
 * src/ir/nodes.ts header). This property is the regression guard: if a future
 * lowering path forgets to set wasmType, this test fails the moment a fixture
 * triggers it.
 */

import { test, describe } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { compileToIR } from './_compile.ts'
import type { IRExpr, IRStmt, IRModule } from '../../src/ir/index.ts'

const EXAMPLES_DIR = join(import.meta.dirname, '../../src/e2e/examples')

/** Expression kinds that are *allowed* to have wasmType === 'void'. */
const VOID_ALLOWED: ReadonlySet<string> = new Set([
    'Block',       // a block whose trailing stmt is itself void
    'Call',        // a call to a void-returning function
    'If',          // an if used as a statement (no else, or both arms void)
    'Return',      // produces no stack value at its position
    'Break',       // unconditional branch — leaves no value
    'Continue',    // unconditional branch — leaves no value
    'Loop',        // loop construct, value comes from break payload only
    'Nop',         // placeholder for type-decl-style nodes
    'Unreachable', // bottom; emits `unreachable`
])

function allFixtures(): { name: string; source: string }[] {
    return readdirSync(EXAMPLES_DIR)
        .filter(f => f.endsWith('.si'))
        .sort()
        .map(name => ({
            name,
            source: readFileSync(join(EXAMPLES_DIR, name), 'utf-8'),
        }))
}

interface Violation {
    fixture: string
    kind: string
    detail: string
}

function* walkExpr(e: IRExpr | undefined): Generator<IRExpr> {
    if (!e) return
    yield e
    switch (e.kind) {
        case 'BinOp':
            yield* walkExpr(e.left); yield* walkExpr(e.right); break
        case 'Call':
            for (const a of e.args) yield* walkExpr(a); break
        case 'Block':
            for (const s of e.stmts) yield* walkStmt(s)
            yield* walkExpr(e.trailing); break
        case 'If':
            yield* walkExpr(e.cond); yield* walkExpr(e.then); yield* walkExpr(e.else_); break
        case 'Loop':
            yield* walkExpr(e.cond); yield* walkExpr(e.body); break
        case 'Return':
            yield* walkExpr(e.value); break
        // leaf nodes have no children: Const, LocalGet, GlobalGet, Break,
        // Continue, Nop, Unreachable
    }
}

function* walkStmt(s: IRStmt): Generator<IRExpr> {
    switch (s.kind) {
        case 'LocalSet':
        case 'GlobalSet':
            yield* walkExpr(s.value); break
        case 'ExprStmt':
            yield* walkExpr(s.expr); break
    }
}

function* walkModule(m: IRModule): Generator<IRExpr> {
    for (const g of m.globals) yield* walkExpr(g.init)
    for (const f of m.functions) yield* walkExpr(f.body)
}

describe('IR type coverage', () => {
    const fixtures = allFixtures()

    test('every IR expression has wasmType set (non-undefined)', () => {
        const violations: Violation[] = []
        for (const { name, source } of fixtures) {
            let ir: IRModule
            try {
                ir = compileToIR(source).ir
            } catch {
                continue
            }
            for (const expr of walkModule(ir)) {
                if (!('wasmType' in (expr as any))) {
                    // These IR node kinds intentionally carry no wasmType
                    // (control flow that produces no stack value, or pure
                    // placeholders — see src/ir/nodes.ts).
                    if (['Loop', 'Break', 'Continue', 'Nop', 'Unreachable', 'Return'].includes(expr.kind)) continue
                    violations.push({
                        fixture: name,
                        kind: expr.kind,
                        detail: 'wasmType field missing entirely',
                    })
                    continue
                }
                const ty = (expr as any).wasmType
                if (ty == null) {
                    violations.push({ fixture: name, kind: expr.kind, detail: `wasmType is ${ty}` })
                }
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `${violations.length} IR expression(s) missing wasmType:\n  ` +
                violations.slice(0, 20).map(v => `${v.fixture} :: ${v.kind} — ${v.detail}`).join('\n  '),
            )
        }
    }, 30000)

    test('non-void wasmType outside the explicit allow-list', () => {
        const violations: Violation[] = []
        for (const { name, source } of fixtures) {
            let ir: IRModule
            try {
                ir = compileToIR(source).ir
            } catch {
                continue
            }
            for (const expr of walkModule(ir)) {
                if (!('wasmType' in (expr as any))) continue
                const ty = (expr as any).wasmType
                if (ty === 'void' && !VOID_ALLOWED.has(expr.kind)) {
                    violations.push({
                        fixture: name,
                        kind: expr.kind,
                        detail: `void wasmType on ${expr.kind} (not in allow-list)`,
                    })
                }
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `${violations.length} disallowed-void IR expression(s):\n  ` +
                violations.slice(0, 20).map(v => `${v.fixture} :: ${v.kind} — ${v.detail}`).join('\n  '),
            )
        }
    }, 30000)
})
