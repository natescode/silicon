// SPDX-License-Identifier: MIT
/**
 * Tests for the comptime handle table.
 */

import { test, expect, describe } from 'bun:test'
import { HandleTable, StringPool } from './handles'
import { createComptimeEnv } from './imports'
import { createElaboratorRegistry } from '../elaborator/registry'
import type { IRConst, IRBinOp, IRIf } from '../ir/nodes'

describe('HandleTable', () => {
    test('intern returns same id for same object', () => {
        const t = new HandleTable<object>()
        const x = {}
        expect(t.intern(x)).toBe(t.intern(x))
    })

    test('intern returns different ids for different objects', () => {
        const t = new HandleTable<object>()
        expect(t.intern({})).not.toBe(t.intern({}))
    })

    test('get round-trips intern', () => {
        const t = new HandleTable<object>()
        const x = { foo: 1 }
        const id = t.intern(x)
        expect(t.get(id)).toBe(x)
    })

    test('get(0) is undefined', () => {
        const t = new HandleTable<object>()
        expect(t.get(0)).toBeUndefined()
    })

    test('ids start at 1', () => {
        const t = new HandleTable<object>()
        expect(t.intern({})).toBe(1)
    })

    test('release frees the id; subsequent get returns undefined', () => {
        const t = new HandleTable<object>()
        const x = {}
        const id = t.intern(x)
        t.release(id)
        expect(t.get(id)).toBeUndefined()
    })

    test('fresh always allocates a new id', () => {
        const t = new HandleTable<object>()
        const x = {}
        const a = t.fresh(x)
        const b = t.fresh(x)
        expect(a).not.toBe(b)
    })

    test('size tracks live handles', () => {
        const t = new HandleTable<object>()
        expect(t.size()).toBe(0)
        const id = t.intern({})
        expect(t.size()).toBe(1)
        t.release(id)
        expect(t.size()).toBe(0)
    })

    test('clear drops everything', () => {
        const t = new HandleTable<object>()
        t.intern({})
        t.intern({})
        t.clear()
        expect(t.size()).toBe(0)
        // ids restart at 1
        expect(t.intern({})).toBe(1)
    })
})

describe('StringPool', () => {
    test('intern returns same id for same content', () => {
        const p = new StringPool()
        expect(p.intern('hello')).toBe(p.intern('hello'))
    })

    test('intern returns different ids for different content', () => {
        const p = new StringPool()
        expect(p.intern('a')).not.toBe(p.intern('b'))
    })

    test('empty string is EMPTY sentinel (id 0)', () => {
        const p = new StringPool()
        expect(p.intern('')).toBe(StringPool.EMPTY)
        expect(p.intern('')).toBe(0)
    })

    test('get(EMPTY) returns empty string', () => {
        const p = new StringPool()
        expect(p.get(StringPool.EMPTY)).toBe('')
    })

    test('get round-trips intern', () => {
        const p = new StringPool()
        const id = p.intern('something')
        expect(p.get(id)).toBe('something')
    })

    test('get of unknown id returns empty string (defensive default)', () => {
        const p = new StringPool()
        expect(p.get(99999)).toBe('')
    })

    test('clear drops everything', () => {
        const p = new StringPool()
        p.intern('x')
        p.clear()
        expect(p.size()).toBe(0)
    })
})

describe('ComptimeEnv.irHandles', () => {
    test('round-trips IR Const through the handle table', () => {
        const env = createComptimeEnv(createElaboratorRegistry())
        const irConst: IRConst = { kind: 'Const', wasmType: 'i32', value: 42 }
        const id = env.irHandles.fresh(irConst)
        expect(id).toBeGreaterThan(0)
        expect(env.irHandles.get(id)).toBe(irConst)
    })

    test('round-trips IR BinOp with nested handles', () => {
        const env = createComptimeEnv(createElaboratorRegistry())
        const left:  IRConst = { kind: 'Const', wasmType: 'i32', value: 1 }
        const right: IRConst = { kind: 'Const', wasmType: 'i32', value: 2 }
        const leftId  = env.irHandles.fresh(left)
        const rightId = env.irHandles.fresh(right)
        const binop: IRBinOp = {
            kind: 'BinOp', wasmType: 'i32', instr: 'i32.add',
            left:  env.irHandles.get(leftId)  as IRConst,
            right: env.irHandles.get(rightId) as IRConst,
        }
        const binopId = env.irHandles.fresh(binop)
        const recovered = env.irHandles.get(binopId) as IRBinOp
        expect(recovered.kind).toBe('BinOp')
        expect(recovered.left).toBe(left)
        expect(recovered.right).toBe(right)
    })

    test('round-trips IR If with optional else slot', () => {
        const env = createComptimeEnv(createElaboratorRegistry())
        const cond:  IRConst = { kind: 'Const', wasmType: 'i32', value: 1 }
        const then:  IRConst = { kind: 'Const', wasmType: 'i32', value: 7 }
        const else_: IRConst = { kind: 'Const', wasmType: 'i32', value: 9 }
        const irIf: IRIf = {
            kind: 'If', wasmType: 'i32', cond, then, else_,
        }
        const id = env.irHandles.fresh(irIf)
        expect(env.irHandles.get(id)).toBe(irIf)
    })

    test('different IR nodes get distinct ids even if structurally similar', () => {
        const env = createComptimeEnv(createElaboratorRegistry())
        const a: IRConst = { kind: 'Const', wasmType: 'i32', value: 42 }
        const b: IRConst = { kind: 'Const', wasmType: 'i32', value: 42 }
        // .fresh() — distinct objects → distinct ids
        expect(env.irHandles.fresh(a)).not.toBe(env.irHandles.fresh(b))
    })

    test('irHandles is independent of generic handles', () => {
        const env = createComptimeEnv(createElaboratorRegistry())
        const node = { type: 'FakeAstNode' }
        const ir:   IRConst = { kind: 'Const', wasmType: 'i32', value: 1 }
        const nodeId = env.handles.intern(node)
        const irId   = env.irHandles.fresh(ir)
        // Both can be id=1; they live in separate tables.
        expect(env.handles.get(nodeId)).toBe(node)
        expect(env.irHandles.get(irId)).toBe(ir)
    })

    test('clear releases all IR handles', () => {
        const env = createComptimeEnv(createElaboratorRegistry())
        env.irHandles.fresh({ kind: 'Const', wasmType: 'i32', value: 1 })
        env.irHandles.fresh({ kind: 'Const', wasmType: 'i32', value: 2 })
        expect(env.irHandles.size()).toBe(2)
        env.irHandles.clear()
        expect(env.irHandles.size()).toBe(0)
    })

    test('handle 0 is reserved (null IR)', () => {
        const env = createComptimeEnv(createElaboratorRegistry())
        expect(env.irHandles.get(0)).toBeUndefined()
    })
})
