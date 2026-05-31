# Bug: WASM binary emitter encodes nested adds in different order than wat2wasm

**Test:** `compileToWasm direct emitter is byte-equal to WAT round-trip`  
**File:** `src/codegen/codegen.test.ts:194`  
**Status:** Failing  
**Severity:** Low — semantically correct, byte-inequal

## Symptom

`compileToWasm` produces a 599-byte module. `watToWasm(compileToWat(...))` also
produces 599 bytes. They diverge at byte 422:

```
viaDirect: ... 0x20 0x00  0x41 0x04  0x6a  0x20 0x02  0x6a  0x2d 0x00 0x00 ...
viaWat:    ... 0x20 0x00  0x41 0x04  0x20 0x02  0x6a  0x6a  0x2d 0x00 0x00 ...
```

Decoded:

| Path       | Stack machine sequence                               | Result        |
|------------|------------------------------------------------------|---------------|
| viaDirect  | `local.get 0` `i32.const 4` **`i32.add`** `local.get 2` `i32.add` | `(A+4)+i`  |
| viaWat     | `local.get 0` `i32.const 4` `local.get 2` **`i32.add`** `i32.add` | `A+(4+i)`  |

Both sequences compute the same value (`A + 4 + i`) — addition is commutative and
associative — so the emitted module is functionally correct. The test enforces
exact byte equality with the wat2wasm round-trip as a strong correctness property.

## Root cause

The divergence is inside `$str_concat` in the embedded `std.wat` runtime. The
relevant WAT expression (line 266 of the generated WAT):

```wat
(i32.add (i32.add (local.get $dst) (i32.const 4)) (local.get $i))
```

`wat2wasm` (wabt) encodes this left-leaning tree as:
```
push $dst → push 4 → push $i → add → add
```

The direct binary emitter (`src/codegen/wasm-emitter.ts`) encodes it as the
more intuitive left-to-right post-order traversal:
```
push $dst → push 4 → add → push $i → add
```

Both are valid WASM; wabt happens to use a different traversal order for this
expression shape. The emitter needs to match wabt's output exactly.

## Reproduction

```ts
import { compileToWat, compileToWasm } from './src/codegen/index.ts'
import { watToWasm } from './src/codegen/toWasm.ts'
// ... set up parse/elaborate/typecheck pipeline ...
const source = "@let add x:Int, y:Int := x + y;"
const viaDirect = compileToWasm(typed, registry, functions)
const viaWat    = await watToWasm(compileToWat(typed, registry, functions))
// viaDirect.byteLength === viaWat.byteLength === 599
// viaDirect[422] === 0x6a  (i32.add)
// viaWat[422]    === 0x20  (local.get)
```

## Fix direction

`wasm-emitter.ts` must reproduce wabt's specific traversal order for nested
binary operations. The simplest approach: when lowering `IRBinOp`, emit both
operands fully before emitting the opcode, but recurse into the right operand
before emitting the left operand's tail `add`. The exact traversal order wabt
uses needs to be matched — likely depth-first right-before-left for the
immediate children of a binary node.

Alternatively, compare the emitter's output against wabt on a range of
expressions to characterise the full ordering rule, then adjust the emitter's
`emitExpr` recursion accordingly.
