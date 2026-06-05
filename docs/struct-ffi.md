# Struct-by-Value FFI — Design Proposal

**Status:** proposal, not implemented. Captures what it would take to let
Silicon pass and return C structs *by value* across `@extern`, so that
struct-based native APIs (raylib's `Camera3D` / `Color` / `Vector3`, most of
libc's `stat`/`timespec`, …) become callable.

**Motivation:** [`examples/cube.si`](../examples/cube.si) draws a rotating cube
with raylib but has to route through raylib's primitive-only `rlgl`
immediate-mode API and do all 3-D maths in Silicon, because the high-level
raylib API passes `Vector3` / `Color` / `Camera3D` by value and Silicon's FFI
can only pass scalars. This doc is the plan to remove that limitation.

---

## 1. The core split — this is a native-only feature

There are two backends with fundamentally different struct stories:

- **WASM.** Core WebAssembly has no struct-by-value calling convention; params
  are scalar `i32/i64/f32/f64`. C libraries compiled to wasm (Emscripten) use a
  bespoke ABI that marshals structs through linear memory, and WasmGC structs
  are *GC heap references*, not C value-structs. So "pass a struct to a C
  function by value" has no meaning on the wasm target — at most you pass a
  pointer into linear memory by convention (see
  [`extern-out-pointer.md`](extern-out-pointer.md)), which the native raylib API
  does not accept.
- **Native (QBE).** This is where struct-by-value is both meaningful and
  achievable. Everything below targets the QBE backend.

The wasm target should therefore *reject* a by-value struct in an `@extern`
signature with a clear diagnostic, and keep offering the out-pointer convention.

---

## 2. Why the native path is tractable — QBE owns the ABI

The hard part of struct-by-value is the **System V AMD64 ABI** eightbyte
classification: structs ≤ 16 bytes are split field-by-field across INTEGER and
SSE registers; larger structs go on the stack (MEMORY class); some returns come
back through a hidden pointer. For raylib:

| C type | size | SysV passing |
|---|---|---|
| `Color` (4×`u8`) | 4 B | one INTEGER register (packed) |
| `Vector2` (2×`float`) | 8 B | one SSE (XMM) register |
| `Vector3` (3×`float`) | 12 B | two SSE registers |
| `Rectangle` / `Vector4` (4×`float`) | 16 B | two SSE registers |
| `Camera3D` (3×`Vector3` + `float` + `int`) | 44 B | MEMORY — on the stack |
| `Matrix` (16×`float`) | 64 B | MEMORY — on the stack |

**QBE implements all of this.** It has first-class aggregate types and lowers
by-value aggregate arguments/returns per the target ABI (amd64 sysv, arm64,
rv64) for us:

```qbe
type :Color    = { b 4 }                      # 4 contiguous bytes
type :Vector3  = { s 3 }                       # 3 contiguous f32
type :Camera3D = { :Vector3, :Vector3, :Vector3, s, w }   # 44 B, nested

# Color c = {230,41,55,255}; DrawCubeV(pos, size, c);
call $DrawCubeV(:Vector3 %pos, :Vector3 %size, :Color %c)

# Vector2 m = GetMousePosition();
%m =:Vector2 call $GetMousePosition()          # QBE returns the aggregate
```

So Silicon does **not** need to implement the eightbyte classifier. It needs to
(a) emit the right `type :T` declarations and (b) hand QBE aggregate values at
the call boundary. The current QBE backend emits *zero* aggregate declarations
([`src/codegen/qbe/lower.ts:267`](../src/codegen/qbe/lower.ts) — `@struct` /
`@type` produce no top-level QBE output; field access is generated functions
over a flat blob).

---

## 3. The genuinely hard part — C-compatible layout

This is a *language* problem, not just codegen. Today a Silicon struct (see
[`struct-design.md`](struct-design.md)) is:

- a **heap pointer** (`i32`), not a value — the opposite of by-value;
- fields at **sequential byte offsets** in declaration order;
- every `Int`/`Bool`/`Float` field is **4 bytes** (no sub-word fields), `Int64`
  is 8 bytes;
- **no alignment or padding** rules;
- **no nested structs** ("field lowering assumes all fields are scalar wasm
  types", `struct-design.md` §Limitations).

Mismatches with the C value-struct ABI:

1. **Pointer, not value.** Need the bytes in registers/stack at the boundary.
2. **No sub-word fields.** `Color` is 4×`u8` = 4 bytes; four 4-byte slots give
   16 bytes — wrong size *and* wrong register class.
3. **No padding/alignment.** C uses natural field alignment + struct tail
   padding; sequential offsets mismatch as soon as widths differ (e.g. an `i64`
   after an `i32`).
4. **No nested structs.** `Camera3D` embeds three `Vector3`s.
5. `Float` = `f32` already matches C `float` (good — raylib's vectors are all
   `float`). `double` fields would need an **`f64`/`Double` type Silicon lacks**
   (tracked as a separate gap, §7).

### Proposed surface: a C-layout struct kind

Introduce a distinct definition keyword — **`@cstruct`** — rather than
overloading `@struct` (keeps the wasm-friendly `@struct` untouched, and a new
keyword is a stratum, so **no grammar change**, per the project's
"add a stratum, not grammar" rule):

```silicon
@cstruct Color   r:UInt8, g:UInt8, b:UInt8, a:UInt8;     #  4 B
@cstruct Vector2 x:Float, y:Float;                        #  8 B
@cstruct Vector3 x:Float, y:Float, z:Float;               # 12 B
@cstruct Camera3D position:Vector3, target:Vector3, up:Vector3, fovy:Float, projection:Int;
```

`@cstruct` semantics:

- Field types restricted to **C-representable** types: `UInt8/16/32/64`,
  `Int`/`Int32`/`Int64`, `Float` (`f32`), pointers (`String`/`Array`), and
  **nested `@cstruct`** types.
- Layout computed with **C rules**: each field at the next offset that is a
  multiple of its alignment; struct alignment = max field alignment; size
  rounded up to a multiple of struct alignment (tail padding).
- A value is still represented internally as a **pointer to a contiguous
  C-layout block** (minimal disruption: construction, field read/write reuse the
  existing pointer machinery). By-value only materializes **at the FFI
  boundary**.

---

## 4. Codegen wiring (once layout exists)

All on the QBE path; `siliconTypeToQbe`/`siliconTypeToQbeReturn` and `lowerCall`
in [`src/codegen/qbe/`](../src/codegen/qbe/) are the touch-points.

1. **Type emission.** For each `@cstruct` reachable from an `@extern` signature,
   emit a QBE `type :T = { … }` (nested types reference other `:T`). New pass in
   `lowerTopLevel`.
2. **Argument passing.** `lowerCall` currently types each arg by its
   `inferredType → siliconTypeToQbe` ([`lower.ts:816`](../src/codegen/qbe/lower.ts)).
   When the callee parameter is a `@cstruct`, pass `:T %ptr` (the value is the
   pointer to the C-layout block) and let QBE classify.
3. **Returns.** Support `function :T $f(...)` and `%r =:T call $f(...)`;
   allocate a result slot, let QBE write the returned aggregate, hand Silicon
   back a pointer to it. `siliconTypeToQbeReturn` only knows scalars today.
4. **Extern signatures naming `@cstruct` types.** The parser/typechecker already
   accept type-name params; they need to resolve to `@cstruct` types and carry
   the layout to the lowerer.
5. **Construction & field access.** Struct literals (`&Color 230,41,55,255`) and
   `.field` reads/writes already exist for `@struct`; reuse with the C layout
   offsets and sub-word loads/stores (`loadub`/`storeb` for `UInt8`, etc.).

The typechecker already has nominal struct types and field resolution
(`ctx.structFields`, `preRegisterStructType`); the missing piece is byte-exact
layout metadata threaded to the QBE lowerer, plus the four wiring points above.

---

## 5. Worked example (target state)

```silicon
@cstruct Color    r:UInt8, g:UInt8, b:UInt8, a:UInt8;
@cstruct Vector3  x:Float, y:Float, z:Float;
@cstruct Camera3D position:Vector3, target:Vector3, up:Vector3, fovy:Float, projection:Int;

@extern InitWindow width:Int, height:Int, title:String;
@extern BeginMode3D camera:Camera3D;           # 44 B struct, by value
@extern DrawCube position:Vector3, w:Float, h:Float, l:Float, color:Color;
@extern EndMode3D;

@fn main:Int := {
    &InitWindow 800, 600, '3D cube';
    @local cam:Camera3D := &Camera3D
        (&Vector3 10.0, 10.0, 10.0), (&Vector3 0.0, 0.0, 0.0),
        (&Vector3 0.0, 1.0, 0.0), 45.0, 0;
    &BeginMode3D cam;
    &DrawCube (&Vector3 0.0, 0.0, 0.0), 2.0, 2.0, 2.0, (&Color 230, 41, 55, 255);
    &EndMode3D;
    0
};
```

---

## 6. Phasing

1. **MVP — register-class structs (≤ 16 B):** `Color`, `Vector2`, `Vector3`,
   `Rectangle`. Needs §3 layout + §4.1/§4.2/§4.5. This alone unlocks most of
   raylib's 2-D and a lot of 3-D drawing.
2. **Struct returns** (§4.3): `GetMousePosition`, `GetColor`, `ColorFromHSV`.
3. **MEMORY-class structs (> 16 B):** `Camera3D`, `Matrix`. Mostly "build in
   memory, pass `:T %ptr`" — QBE handles stack placement; main extra work is
   nested-struct layout and construction.
4. **wasm-target rejection diagnostic** for by-value struct externs.

Effort: the MVP is moderate — a few hundred lines plus tests — precisely because
QBE absorbs the ABI. The bulk is the layout model and construct/marshal
plumbing, not register allocation.

---

## 7. Related gaps & alternatives

- **`f64` / `Double`.** Independent of structs but adjacent: needed for `double`
  fields and `double` params/returns (`GetTime`, `rlFrustum`, `rlOrtho`). QBE
  has the `d` base type; Silicon's `Float` is `f32` only. A `Double` type would
  slot into `siliconTypeToQbe` as `d`.
- **Variadics** (`printf`) are a separate FFI item (QBE supports `...` in calls);
  unrelated to structs but often wanted alongside.
- **Available today without compiler changes:**
  - **C shim** — a few lines of C wrapping struct-taking functions behind
    primitive signatures (`void DrawCubeXYZ(float,float,float, …, int,int,int)`),
    compiled alongside the QBE assembly.
  - **`rlgl` route** — raylib's primitive-only immediate-mode API, as used in
    [`examples/cube.si`](../examples/cube.si).

---

## 8. Open questions

- Should `@cstruct` and `@struct` unify (one keyword, C layout inferred when all
  fields are C-representable), or stay distinct for clarity? Distinct is the
  safer first cut.
- Native heap for `@cstruct` blocks: reuse the wasm-style bump `alloc`, or move
  to real `malloc`/arena on native? The cube example shows the native backend
  already maps the linear-memory model to QBE memory ops.
- Passing a `@cstruct` *by pointer* to an extern that wants `T*` (vs by value) —
  likely just "take the address", but the surface for "address-of" needs a
  decision.

---

## 9. References

- [`struct-design.md`](struct-design.md) — current `@struct` layout (the
  starting point this proposal extends).
- [`extern-out-pointer.md`](extern-out-pointer.md) — the out-pointer convention
  (the wasm-side answer to "return more than a scalar").
- [`targets.md`](targets.md) — WASM vs native targets, `@extern` patterns,
  native string layout.
- [`examples/cube.si`](../examples/cube.si) — the motivating example.
- QBE language spec, "Aggregate Types" and "ABI" sections — the mechanism this
  design leans on.
