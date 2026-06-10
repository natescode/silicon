// SPDX-License-Identifier: MIT
/**
 * ADR 0017/0019 — the bindgen EVENT/callback tier, end-to-end.
 *
 * A callback-taking host API (`addEventListener(type, listener)`, `setTimeout(cb,
 * ms)`, …) binds its callback param as the closure-handle type `Callback`, emitted
 * as `Vec[Int]` in the `.si` (a `(ref $Vec_i32)` under wasm-gc).  The guest passes
 * `@export_callback(@closure(handler, …caps))`; the host shim wraps the handle with
 * `closureToFn(cb)` into a plain JS function it registers/calls, dispatching back
 * through the exported `__closure_invoke_<k>` trampoline with the captured env.
 *
 * This verifies the generated artifacts (Callback → `Vec[Int]`, `closureToFn(cb)`
 * in the shim) AND runs the full round-trip under Bun's wasm-gc: a closure crosses
 * `@extern` as an engine-GC'd ref, the host invokes it via the trampoline.
 */

import { test, expect, describe } from 'bun:test'
import { buildIR, emitModuleSi, emitHostModule } from './src/generate'
import type { BindingSpec } from './src/spec'
import { compileToWasm } from '../src/codegen/index'
import siliconGrammar from '../src/grammar/SiliconGrammar'
import parse from '../src/parser'
import { addToAstSemantics } from '../src/ast/index'
import { buildStrataRegistry, elaborate } from '../src/elaborator/index'
import { typecheck } from '../src/types/index'
import { makeClosureToFn } from '../src/codegen/async-reactor'
import type { Program } from '../src/ast/astNodes'

describe('bindgen event tier — Callback params + closureToFn dispatch', () => {
    test('a Callback param is emitted as Vec[Int] in the .si and closureToFn-wrapped in the shim', () => {
        // setTimeout-shaped: `set_timeout(callback, ms)`.
        const spec: BindingSpec = {
            name: 'set_timeout',
            params: [{ name: 'cb', type: 'Callback' }, { name: 'ms', type: 'Float' }],
            result: 'Void', impl: { kind: 'static', iface: 'globalThis', method: 'setTimeout' }, source: 'demo',
        }
        const ir = buildIR('timers', [spec])
        expect(emitModuleSi(ir, 'demo', 'jsstring')).toContain('\\\\ @extern set_timeout (Vec[Int], Float);')
        // the closure handle is turned into a JS function before the host call.
        expect(emitHostModule(ir, '', 'jsstring')).toContain('globalThis.setTimeout(closureToFn(cb), ms)')
    })

    test('END-TO-END: a closure crosses a Vec[Int]-callback @extern and the host invokes it via the trampoline', async () => {
        // The @extern shape the event tier generates (callback param = Vec[Int]).
        const src = `\\\\ @extern call_cb (Vec[Int], Int) -> Int;
\\\\ scale (Int, Int) -> Int
@fn scale factor, x := { factor * x };
\\\\ run (Int, Int) -> Int
@fn run factor, x := { call_cb(@export_callback(@closure(scale, factor)), x) };
@export run;`
        const ast = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as Program
        const registry = buildStrataRegistry(ast)
        const { program: elaborated } = elaborate(ast, registry, [], 'wasm-gc')
        const { program: typed, functions } = typecheck(elaborated, registry, undefined, 'wasm-gc')
        const bin = compileToWasm(typed, registry, functions, undefined, { target: 'wasm-gc' })
        expect(await WebAssembly.validate(bin)).toBe(true)

        // The host receives the closure handle, wraps it via closureToFn (the
        // mirror of the generated shim's `closureToFn(cb)`), and CALLS it — exactly
        // what `setTimeout`/`addEventListener` would do later on an event.
        let closureToFn: (h: any) => (...a: number[]) => number
        const inst = await WebAssembly.instantiate(bin, {
            env: { print: () => {}, read: () => 0, call_cb: (cb: any, x: number) => closureToFn(cb)(x) },
        })
        closureToFn = makeClosureToFn(inst.instance)
        const ex = inst.instance.exports as any
        expect(ex.run(3, 5)).toBe(15)   // host invoked the closure: scale(3, 5)
        expect(ex.run(10, 4)).toBe(40)  // scale(10, 4) — captured factor flows through
    })
})
