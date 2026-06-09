// SPDX-License-Identifier: MIT
/**
 * ADR 0018 Phase 4 / ADR 0019 C3 — the poll-reactor, end-to-end.
 *
 * A "future" is a closure (C1) over a mutable poll-state pointer that returns
 * PENDING until ready; `block_on` drives one to completion and `block_all` drives
 * MANY concurrently (each round polls every still-pending future, so independent
 * futures progress interleaved — the true-concurrency model single-in-flight
 * Asyncify can't do). Compiles real Silicon (vec.si + future.si) and runs the WASM.
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

const vecSrc = readFileSync(join(__dirname, 'vec.si'), 'utf-8')
const futureSrc = readFileSync(join(__dirname, 'future.si'), 'utf-8')

// A delay future: poll_delay advances a captured 1-slot state vec each poll and
// becomes ready (returning `value`) once it has been polled `deadline` times.
const DELAY_FUTURES = `\\\\ poll_delay (Int, Int, Int) -> Int
@fn poll_delay state, deadline, value := {
    t := vec_get_i32(state, 0) + 1;
    vec_set_i32(state, 0, t);
    @if(t >= deadline, { value }, { future_pending() })
};
\\\\ make_delay (Int, Int) -> Int
@fn make_delay deadline, value := {
    state := vec_new(1);
    vec_push_i32(state, 0);
    @closure(poll_delay, state, deadline, value)
};`

async function compileRun(programSrc: string): Promise<any> {
    const source = `${vecSrc}\n${futureSrc}\n${DELAY_FUTURES}\n${programSrc}`
    const ast = addToAstSemantics(siliconGrammar)(parse(source)).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program, errors } = elaborate(ast, registry)
    expect(errors ?? []).toEqual([])
    const { program: typed, functions } = typecheck(program, registry)
    const bin = compileToWasm(typed, registry, functions)
    const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
    return mod.instance.exports as any
}

describe('ADR 0018/0019 — poll-reactor (Future + block_on/block_all)', () => {
    test('block_on drives a single future to completion', async () => {
        const ex = await compileRun(`\\\\ run () -> Int
@fn run := { block_on(make_delay(5, 42)) };
@export run;`)
        expect(ex.run()).toBe(42)   // ready after 5 polls
    })

    test('block_all drives many futures concurrently and sums their results', async () => {
        const ex = await compileRun(`\\\\ run () -> Int
@fn run := {
    futures := vec_new(3);
    vec_push_i32(futures, make_delay(2, 10));
    vec_push_i32(futures, make_delay(4, 20));
    vec_push_i32(futures, make_delay(3, 30));
    block_all(futures)
};
@export run;`)
        expect(ex.run()).toBe(60)   // 10 + 20 + 30, the three polled interleaved
    })

    test('futures progress independently — different deadlines all complete', async () => {
        // A future that is ready immediately (deadline 1) alongside a slow one
        // (deadline 8): block_all must keep polling the slow one after the fast
        // one resolves, not block on it.
        const ex = await compileRun(`\\\\ run () -> Int
@fn run := {
    futures := vec_new(2);
    vec_push_i32(futures, make_delay(1, 7));
    vec_push_i32(futures, make_delay(8, 100));
    block_all(futures)
};
@export run;`)
        expect(ex.run()).toBe(107)  // 7 + 100
    })
})
