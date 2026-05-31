// SPDX-License-Identifier: MIT
/**
 * Phase 4 — @defer stratum tests.
 *
 * Exercises the @defer cleanup mechanism:
 *  - keyword registration and handler compilation
 *  - end-of-body cleanup runs in LIFO order
 *  - early @return runs cleanups first
 *  - non-void return preserves value via synthetic local
 *  - functions with no @defer compile unchanged
 */

import { test, expect, describe } from 'bun:test'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import elaborate from '../elaborator/elaborator'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import { lookupKeyword } from '../elaborator/registry'
import { compileStrataHandlers } from '../comptime/engine'
import typecheck from '../types/typechecker'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import type { IRExpr, IRBlock, IRStmt } from '../ir/nodes'

function parseProgram(src: string): any {
    return addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
}

async function compile(src: string) {
    const prog = parseProgram(src)
    const registry = buildStrataRegistry(prog)
    await compileStrataHandlers(prog, registry)
    const elab = elaborate(prog, registry)
    const { program: typedProg, functions } = typecheck(elab.program, registry)
    const mod = lowerProgram(typedProg, registry, functions)
    return { mod, registry }
}

function getFn(mod: any, name: string) {
    const fn = mod.functions.find((f: any) => f.name === name)
    if (!fn) throw new Error(`function ${name} not found in module (found: ${mod.functions.map((f:any)=>f.name).join(',')})`)
    return fn
}

function isBlock(e: IRExpr | undefined): e is IRBlock {
    return !!e && (e as any).kind === 'Block'
}

describe('Phase 4: @defer keyword registration', () => {
    test('@defer keyword is registered in the strata registry', () => {
        const prog = parseProgram('')
        const registry = buildStrataRegistry(prog)
        expect(lookupKeyword(registry, '@defer')).toBeDefined()
    })

    test('Defer_lower is claimed as a named handler', () => {
        const prog = parseProgram('')
        const registry = buildStrataRegistry(prog)
        expect(registry.strataHandlerFnNames.has('Defer_lower')).toBe(true)
        expect(registry.namedHandlers.has('Defer_lower')).toBe(true)
    })

    test('Defer_lower compiles to a WASM instance', async () => {
        const prog = parseProgram('')
        const registry = buildStrataRegistry(prog)
        await compileStrataHandlers(prog, registry)
        expect(registry.compiledHandlers.has('Defer_lower')).toBe(true)
    })
})

describe('Phase 4: @defer end-of-body cleanup', () => {
    test('single @defer in void function appends cleanup after body', async () => {
        const { mod } = await compile(`
            @extern cleanup;
            @fn foo := {
                &@defer &cleanup;
                42
            };
        `)
        const fn = getFn(mod, 'foo')
        expect(fn.body).toBeDefined()
        // The body is wrapped: original body (Block with @defer Nop + trailing 42)
        // hoisted into __defer_result, then ExprStmt(call $cleanup), then trailing LocalGet.
        const wrap = fn.body as IRBlock
        expect(wrap.kind).toBe('Block')
        // Either LocalSet (i32) or ExprStmt (void) at index 0 is the body capture.
        const cleanupStmts = wrap.stmts.slice(1)
        const cleanupCount = cleanupStmts.filter((s: IRStmt) =>
            s.kind === 'ExprStmt' &&
            (s.expr as any).kind === 'Call' &&
            (s.expr as any).callee.includes('cleanup'),
        ).length
        expect(cleanupCount).toBe(1)
    })

    test('multiple @defers run in LIFO order at end of body', async () => {
        const { mod } = await compile(`
            @extern first;
            @extern second;
            @extern third;
            @fn foo := {
                &@defer &first;
                &@defer &second;
                &@defer &third;
                0
            };
        `)
        const fn = getFn(mod, 'foo')
        const wrap = fn.body as IRBlock
        expect(wrap.kind).toBe('Block')
        // Skip the body-capture stmt (LocalSet or ExprStmt(body)), then read
        // the three cleanup ExprStmts in LIFO source order (third, second, first).
        const cleanupCallees: string[] = []
        for (let i = 1; i < wrap.stmts.length; i++) {
            const s = wrap.stmts[i]
            if (s.kind === 'ExprStmt' && (s.expr as any).kind === 'Call') {
                cleanupCallees.push((s.expr as any).callee)
            }
        }
        const names = cleanupCallees.map(c => c.replace(/^\$/, ''))
        expect(names).toEqual(['third', 'second', 'first'])
    })

    test('function with no @defer is not wrapped (body emitted unchanged)', async () => {
        const { mod } = await compile(`@fn foo := { 42 };`)
        const fn = getFn(mod, 'foo')
        // Without @defer, the body should be the i32 literal Block (or just Const),
        // never a synthetic LocalSet/__defer_result/LocalGet wrap.
        const wat = emitModule(mod, '')
        expect(wat).not.toContain('__defer_result')
    })

    test('non-void function with @defer preserves return value via temp local', async () => {
        const { mod } = await compile(`
            @extern cleanup;
            @fn foo:Int := {
                &@defer &cleanup;
                42
            };
        `)
        const wat = emitModule(mod, '')
        expect(wat).toContain('__defer_result')
        // Function still returns i32.
        expect(wat).toContain('(result i32)')
        // Cleanup call must precede the trailing LocalGet of the temp.
        const cleanupIdx = wat.indexOf('call $cleanup')
        const localGetIdx = wat.indexOf('local.get $__defer_result')
        expect(cleanupIdx).toBeGreaterThan(0)
        expect(localGetIdx).toBeGreaterThan(cleanupIdx)
    })
})

describe('Phase 4: @defer with @return', () => {
    test('@return runs pending defers before the return', async () => {
        const { mod } = await compile(`
            @extern cleanup;
            @fn foo:Int := {
                &@defer &cleanup;
                &@return 99
            };
        `)
        const wat = emitModule(mod, '')
        // Cleanup call must appear before the `(return ...)` in source order.
        const cleanupIdx = wat.indexOf('call $cleanup')
        const returnIdx = wat.indexOf('return')
        expect(cleanupIdx).toBeGreaterThan(0)
        expect(returnIdx).toBeGreaterThan(cleanupIdx)
    })

    test('multiple @defers + @return: cleanups fire in LIFO order before return', async () => {
        const { mod } = await compile(`
            @extern first;
            @extern second;
            @fn foo:Int := {
                &@defer &first;
                &@defer &second;
                &@return 7
            };
        `)
        const wat = emitModule(mod, '')
        const secondIdx = wat.indexOf('call $second')
        const firstIdx = wat.indexOf('call $first')
        const returnIdx = wat.indexOf('return')
        expect(secondIdx).toBeGreaterThan(0)
        expect(firstIdx).toBeGreaterThan(secondIdx)
        expect(returnIdx).toBeGreaterThan(firstIdx)
    })
})
