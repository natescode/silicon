// SPDX-License-Identifier: MIT
/**
 * M0 — the PRODUCTION @fn[T] monomorphization stratum (src/strata/generics.si).
 *
 * HM-lite typechecks `@fn[T]` polymorphically but codegen used to emit one
 * type-erased i32 copy — so a Float instantiation produced INVALID WASM
 * (`call $id (f32.const …)` against `(param i32)` fails validation; the bug
 * was masked because no test instantiated the same generic at f32 and then
 * actually assembled the module).
 *
 * The T0 generics stratum fixes this additively, per call site, memoized:
 * i32-shaped instantiations keep the erased copy (zero codegen change);
 * Float/Int64/ref instantiations get a specialized monomorph (`id$Float`)
 * and the call site is rewritten to it.  No compiler special case — the
 * stratum runs as compiled WASM on the comptime engine like any other.
 */

import { test, expect, describe } from 'bun:test'
import { buildStrataRegistry } from './strataLoader'
import elaborate from './elaborator'
import typecheck from '../types/typechecker'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import { watToWasm } from '../codegen/toWasm'

function compile(src: string): string {
    const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(prog)
    const elab = elaborate(prog, registry)
    const { program: typedProg, functions, errors } = typecheck(elab.program, registry)
    if (errors.length > 0) throw new Error(errors.map((e: any) => e.message).join('\n'))
    return emitModule(lowerProgram(typedProg, registry, functions))
}

async function run(src: string): Promise<Record<string, Function>> {
    const wat = compile(src)
    const wasm = await watToWasm(wat)
    const { instance } = await WebAssembly.instantiate(wasm, {
        env: { print: () => {}, read: () => 0 },
    } as any)
    return instance.exports as any
}

describe('production @fn[T] monomorphization (generics.si)', () => {
    test('Float instantiation emits id$Float and the module validates + runs', async () => {
        const exports = await run(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ use_i Int
@fn use_i := id(42);
\\\\ use_f Float
@fn use_f := id(3.5);
@export use_i;
@export use_f;`)
        expect((exports.use_i as any)()).toBe(42)
        expect((exports.use_f as any)()).toBe(3.5)
    })

    test('the Int call keeps the erased base copy; only Float monomorphizes', () => {
        const wat = compile(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ use_i Int
@fn use_i := id(42);
\\\\ use_f Float
@fn use_f := id(3.5);`)
        // Erased base copy still serves the Int call…
        expect(wat).toMatch(/\(func \$id \(param \$x i32\)/)
        expect(wat).toMatch(/\$use_i[\s\S]*call \$id[^$]/)
        // …and the Float call resolves to a real f32 monomorph.
        expect(wat).toMatch(/\(func \$id\$Float \(param \$x f32\) \(result f32\)/)
        expect(wat).toMatch(/\$use_f[\s\S]*call \$id\$Float/)
        // No spurious Int monomorph — i32-shaped stays erased.
        expect(wat).not.toContain('$id$Int')
    })

    test('two Float call sites share one memoized monomorph', () => {
        const wat = compile(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ a Float
@fn a := id(1.5);
\\\\ b Float
@fn b := id(2.5);`)
        const occurrences = wat.match(/\(func \$id\$Float /g) ?? []
        expect(occurrences.length).toBe(1)
        expect(wat).toMatch(/\$a[\s\S]*call \$id\$Float/)
        expect(wat).toMatch(/\$b[\s\S]*call \$id\$Float/)
    })

    test('Int64 instantiation monomorphizes and runs (sum exceeds i32 range)', async () => {
        const exports = await run(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ use_l Int64
@fn use_l := (id(@toInt64(2000000000)) + id(@toInt64(2000000000)));
@export use_l;`)
        expect((exports.use_l as any)()).toBe(4000000000n)
    })

    test('generic-calling-generic chain monomorphizes transitively at Float', async () => {
        const exports = await run(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ double_id[T] (T)
@fn double_id[T] x := id(x);
\\\\ use_f Float
@fn use_f := double_id(2.25);
@export use_f;`)
        expect((exports.use_f as any)()).toBe(2.25)
    })

    test('declaration order does not matter — caller before the generic def', async () => {
        const exports = await run(`\\\\ use_f Float
@fn use_f := id(4.5);
\\\\ id[T] (T)
@fn id[T] x := x;
@export use_f;`)
        expect((exports.use_f as any)()).toBe(4.5)
    })

    test('a Float arg flowing through a typed local also monomorphizes', async () => {
        const exports = await run(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ use_f (Float) -> Float
@fn use_f y := id(y);
@export use_f;`)
        expect((exports.use_f as any)(7.5)).toBe(7.5)
    })

    test('multi-param generic: T shared across params at Float', async () => {
        const exports = await run(`\\\\ pick[T] (Bool, T, T)
@fn pick[T] c, a, b := @if(c, { a }, { b });
\\\\ use_f Float
@fn use_f := pick(@true, 1.5, 2.5);
@export use_f;`)
        expect((exports.use_f as any)()).toBe(1.5)
    })

    test('String instantiation stays on the erased copy (i32-shaped, status quo)', () => {
        const wat = compile(`\\\\ id[T] (T)
@fn id[T] x := x;
\\\\ use_s String
@fn use_s := id('hello');`)
        expect(wat).toMatch(/\(func \$id \(param \$x i32\)/)
        expect(wat).not.toContain('$id$String')
    })
})
