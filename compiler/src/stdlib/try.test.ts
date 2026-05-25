/**
 * Phase 5a-3 — `@try` unwrap shorthand for Result.
 *
 * Compiles a Silicon program that uses `&@try r` inside a function that
 * itself returns Result[U, E], and verifies the runtime behaviour:
 *   - When r is Ok(v), `&@try r` evaluates to v and execution continues.
 *   - When r is Err(e), `&@try r` short-circuits the enclosing function,
 *     propagating the original Err pointer unchanged.
 */

import { test, expect, describe } from 'bun:test'
import { join } from 'path'
import { readFileSync } from 'fs'
import { compileToWasm } from '../codegen/index'
import siliconGrammar from '../grammar/SiliconGrammar'
import parse from '../parser'
import { addToAstSemantics } from '../ast/index'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import type { Program } from '../ast/astNodes'

const resultSrc = readFileSync(join(__dirname, 'result.si'), 'utf-8')

interface Exports {
    memory: WebAssembly.Memory
    [name: string]: any
}

async function compileAndRun(extra: string): Promise<Exports> {
    const source = `${resultSrc}\n${extra}`
    const ast = addToAstSemantics(siliconGrammar)(parse(source)).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    const bin = compileToWasm(typed, registry, functions)
    const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
    return mod.instance.exports as unknown as Exports
}

describe('Phase 5a-3: @try unwrap shorthand', () => {
    test('@try on Ok extracts the value; execution continues', async () => {
        const ex = await compileAndRun(`
            @fn double:Result[Int, Int] r:Result[Int, Int] := {
                @local v:Int := &@try r;
                &Ok (v * 2)
            };
            @fn test_ok:Int := {
                @local r:Result[Int, Int] := &double (&Ok 21);
                &result_unwrap_or r, 0
            };
            @export test_ok;
        `)
        expect(ex.test_ok()).toBe(42)
    })

    test('@try on Err early-returns; the trailing expression never runs', async () => {
        // If @try didn't short-circuit on Err, `(v * 2)` would execute and
        // the function would re-wrap garbage in Ok.  We assert (a) the
        // wrapper returns Err (result_is_ok = 0) and (b) result_unwrap_or
        // falls through to the default.
        const ex = await compileAndRun(`
            @fn double:Result[Int, Int] r:Result[Int, Int] := {
                @local v:Int := &@try r;
                &Ok (v * 2)
            };
            @fn test_err_unwrap:Int := {
                @local r:Result[Int, Int] := &double (&Err 99);
                &result_unwrap_or r, 1234
            };
            @fn test_err_is_ok:Int := {
                @local r:Result[Int, Int] := &double (&Err 99);
                &result_is_ok r
            };
            @export test_err_unwrap;
            @export test_err_is_ok;
        `)
        expect(ex.test_err_unwrap()).toBe(1234)  // default used → Err
        expect(ex.test_err_is_ok()).toBe(0)      // result_is_ok == false
    })

    test('@try propagates Err with the original payload intact (not a copy)', async () => {
        // Verifies that the propagated Err carries the same error value
        // through the chain.  The intermediate `double` returns immediately
        // without re-wrapping, so the caller sees the original Err's
        // error field at offset +4.
        const ex = await compileAndRun(`
            @fn double:Result[Int, Int] r:Result[Int, Int] := {
                @local v:Int := &@try r;
                &Ok (v * 2)
            };
            @fn test_err_value:Int := {
                @local r:Result[Int, Int] := &double (&Err 7777);
                # Err's error field is at offset +4 (same slot as Ok's value
                # under @struct's pad-to-max layout).
                &WASM::i32_load (r + 4)
            };
            @export test_err_value;
        `)
        expect(ex.test_err_value()).toBe(7777)
    })

    test('chained @try: an outer fn calling an inner @try-using fn sees the Err', async () => {
        const ex = await compileAndRun(`
            @fn inner:Result[Int, Int] x:Int := {
                &@if x > 0, { &Ok (x * 10) }, { &Err x }
            };
            @fn outer:Result[Int, Int] x:Int := {
                @local v:Int := &@try (&inner x);
                &Ok (v + 1)
            };
            @fn test_chained_ok:Int := {
                @local r:Result[Int, Int] := &outer 4;
                &result_unwrap_or r, 0
            };
            @fn test_chained_err:Int := {
                @local r:Result[Int, Int] := &outer (0 - 5);
                &result_unwrap_or r, 999
            };
            @export test_chained_ok;
            @export test_chained_err;
        `)
        expect(ex.test_chained_ok()).toBe(41)   // 4 * 10 + 1
        expect(ex.test_chained_err()).toBe(999) // Err propagated through both fns
    })

    test('@try with comma-list arity errors at lower time', async () => {
        let threw = false
        try {
            await compileAndRun(`
                @fn bad:Result[Int, Int] := {
                    @local v:Int := &@try (&Ok 1), (&Ok 2);
                    &Ok v
                };
                @export bad;
            `)
        } catch (e) {
            threw = true
            expect((e as Error).message).toContain('@try expects exactly 1 argument')
        }
        expect(threw).toBe(true)
    })
})
