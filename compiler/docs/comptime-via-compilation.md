# Comptime via Compilation

**Goal:** Replace the strata body interpreter with a *compile-then-run* model
where strata bodies are first-class Silicon programs, lowered through the
normal pipeline, and invoked by the compiler at compile time via a
compiler-as-imports surface. One language, one evaluator, no chicken-egg.

**Status:** FULLY SHIPPED (2026-05-24).
  - Phases A–C: complete.
  - Phase B import-surface continuation: all 13 D-B-* stories ✅.
  - Phase D per-stratum migrations: all 14 D-D-* stories ✅.
  - Phase E interpreter retirement: all 4 D-E-* stories ✅.
    - D-E-1 ✅ pre-compile in buildStrataRegistry; primary-path fallback removed
    - D-E-2 ✅ legacy rich-body code paths removed
    - D-E-3 ✅ strataBody.ts (~250 LOC) + comptimeBuiltins.ts (~140 LOC)
      both deleted.  Inline-block handlers are auto-extracted to
      synthetic @fns via the legacyBlockTranslator and compiled through
      the Phase C engine — no AST-walking interpreter at fire time.
    - D-E-4 ✅ docs updated.

The strata-body interpreter is fully retired.  Every handler — named or
inline — runs as compiled WASM via the Phase C engine.

Original design proposal dated 2026-05-22.

---

## As-shipped status (2026-05-23)

### Phase A — Strata bodies as first-class Silicon programs — ✓ SHIPPED

- Strata can reference top-level `@fn`s as handlers:
  `&Compiler::on::decl '@token', MyHandler;` paired with
  `@fn MyHandler node:Int := { ... };`
- Body still interpreted (Phase A is the bridge; Phase C compiles it).
- Pre-pass in `buildStrataRegistry` collects every top-level `@fn` body
  into `registry.namedHandlers` so forward references resolve.
- `registry.strataHandlerFnNames` tracks which `@fn`s are claimed as
  handlers; the lowerer skips those (their `&Compiler::*` calls have no
  runtime meaning in the interpreter model).
- 11 dedicated tests in `src/elaborator/dissolution-phase-a.test.ts`.

### Phase B — Compiler-as-imports surface — ✓ SHIPPED (foundation + expansion)

- `src/comptime/handles.ts` — `HandleTable<T>` and `StringPool` for the
  i32-handle ABI between host JS and WASM strata bodies.
- `src/comptime/imports.ts` — host implementations of the import surface
  for `register::*`, `on::*`, `state::*`, plus a test-only
  `test_observe` hook. Returns a `WebAssembly.Imports` object ready for
  `instantiate`.
- `src/comptime/IR_HANDLE_ABI.md` — the IR-handle ABI design (D-B-1).
- **D-B-2 (IR-handle table):** `ComptimeEnv.irHandles` added, plus 7
  round-trip tests in `handles.test.ts`.
- **D-B-3 (basic IR builders):** `ir_makeConst`, `ir_makeLocalGet/Set`,
  `ir_makeGlobalGet/Set`, `ir_makeBinOp`, `ir_makeBlock`,
  `compiler_arr_new/push`, `ir_null` — 15 tests in `imports.test.ts`.
- **D-B-4 (control flow):** `ir_makeIf`, `ir_makeLoop`,
  `ir_makeBreak/Continue`, `ir_makeReturn` — 10 tests.
- **D-B-5 (module-level):** `ir_makeExport`, `ir_makeLocal/Param`,
  `ir_makeGlobal`, `ir_makeFunction`, `ir_makeImport`,
  `compiler_arr_push_str` — 10 tests.
- **D-B-9 (module accumulators):** `module_push_definition`,
  `module_push_global` — 3 tests.
- **D-B-10 (diagnostics):** `diag_error`, `diag_warn` — 4 tests.
- **D-B-11 (ctx accessors):** `compiler_ctx_locals/globals/varNames/
  pendingLocals/loopStack`, `compiler_ctx_nextLoopId`,
  `compiler_isVarName` — 9 tests.
- **D-B-13 (utility helpers):** `compiler_watId`, `compiler_freshId`,
  `compiler_arg`, `compiler_choose` — 9 tests.
- **D-B-7 (AST field accessor):** `compiler_ast_field` with tagged i32
  returns (NODE/STR/INT/BOOL/ARR), `compiler_tag_kind/_value`,
  `compiler_arr_len/_get` — 11 tests.
- **D-B-8 (types-as-data):** `type_int/int64/float/bool/string/void`,
  `type_variable`, `type_array`, `type_equals`, `type_format`,
  `type_substitute`, `type_mangle_suffix` — 9 tests.
- **D-B-6 (AST manipulation):** `ast_capture_template`, `ast_clone`,
  `ast_with_keyword`, `ast_with_name`, `ast_rewrite_call`,
  `ast_patch_types` — 9 tests.
- **D-B-12 (lowering helpers):** `compiler_lowerExpr`,
  `compiler_lowerExprIfDefined`, `compiler_lowerParams`,
  `compiler_lowerFunctionBody`, `compiler_funcResult_body/_locals`,
  `compiler_resolveFunctionReturnType`, `compiler_resolveType`.
  `ComptimeEnv` gains an optional `api?: CompilerAPI` slot for
  per-firing wiring — 7 tests.

**All 13 Phase B stories complete.**  Next: D-D per-stratum migrations,
gated on adding "compiler" to the moduleRegistry so handler-@fn source
can call `&compiler::*` imports.

### Phase C — Compile-then-run engine — ✓ SHIPPED (minimum viable)

- `src/comptime/engine.ts` — `compileHandlerToWasm(name, prog, registry)`
  lowers a single `@fn` handler through the normal pipeline, instantiates
  via `WebAssembly.instantiate` with the Phase B imports, and returns a
  callable.
- `compileStrataHandlers(prog, registry)` — opt-in async pass that
  pre-compiles every claimed handler and caches successful results in
  `registry.compiledHandlers`.
- `tryCompileHandler` — best-effort variant that returns `null` on
  failure, used by the bridge wrapper to fall back to the interpreter.
- The named-handler wrapper in `strataLoader.ts` checks
  `registry.compiledHandlers` first; if a compiled instance exists, it
  invokes the WASM function. Otherwise, fallback to the interpreter.
- 8 dedicated tests in `src/comptime/engine.test.ts` covering: identity
  handler, literal-constant handler, arithmetic handler, branching
  handler, cache population, and the fallback path.

**What works end-to-end today:**

```silicon
@stratum Bridge := {
    &Compiler::register::keyword '@bridge';
    &Compiler::on::decl '@bridge', Bridge_handler;
};
@fn Bridge_handler n:Int := { (n + n) };
```

`Bridge_handler` is compiled to a real WASM function. When `@bridge X;`
appears in user code, the lowerer fires the registered handler, which
invokes the compiled WASM, returning `2 * node-handle`. (The handler
doesn't yet see the actual AST node — the handle passed is 0 for now;
full AST-field accessors are a Phase B continuation.)

### Phase D groundwork — T0 loader extended (2026-05-23)

The builtin-strata loader (T0) now handles the new `@stratum :=` unified
form and the top-level `@fn` pre-pass, parallel to T1 and T2.  Before
this change, a builtin .si file using the new form would have been
silently skipped by `parseBuiltinStrata` (which only walked Elaboration
nodes for legacy `@stratum_keyword`/`@stratum_operator`).

What's unblocked:
- A builtin .si file can mix legacy strata with new-form strata
- Per-file migration of `src/strata/*.si` is now mechanical
- The `@fn` pre-pass also extends to T2 extraSources so `on::*`
  references to handler `@fn`s declared in external sources resolve

3 new tests in `src/elaborator/dissolution-t0.test.ts` lock this in.

### What's left — Phase D, the rest of B, and Phase E

**Phase D — migrate existing strata to the named-handler form**
- Today: all `src/strata/*.si` use the legacy `@stratum_keyword`/`@stratum_operator`
  forms with inline rich bodies. The Phase A pre-pass collects @fn bodies,
  but the existing strata don't *have* their bodies as @fns.  The T0 loader
  is *ready* for migrated strata; only the per-file rewrite work remains.
- Migration recipe per stratum:
  1. Rewrite `@stratum_keyword X ('@foo', Node) = { body }` as:
     ```silicon
     @stratum X := {
         &Compiler::register::keyword '@foo';
         &Compiler::on::lower '@foo', X_lower;
     };
     @fn X_lower node:Int := { body };
     ```
     For operators: `&Compiler::register::operator '+'` and
     `&Compiler::on::lower '+', X_lower`.
  2. Audit the body for every `&Compiler::*` and `&IR::*` call.
     Each one must have a corresponding host-side import in
     `src/comptime/imports.ts`.  Extend the import surface as needed.
     Most IR builders (`makeIf`, `makeBinOp`, …) need the IR-handle
     ABI which isn't yet built — see "Phase B continuation" below.
  3. Add an entry to your local test that exercises `@foo` via real
     user code.  Confirm `compileStrataHandlers` either compiles the
     handler successfully (new path) or returns null (interpreter
     fallback, no behavioral change).
  4. Repeat per stratum.

#### Realistic per-stratum effort

| File | Declarations | Body complexity | Effort estimate |
|---|---|---|---|
| `metadata.si` | 2 (`@export`, `@platform`) | Low — one is a no-op, one needs `watId`+`isVarName`+`ir::makeExport` | 0.5 day |
| `defkinds.si` | 10 | High — `@let`/`@fn` use `lowerParams`, `lowerFunctionBody`, `resolveFunctionReturnType`, `ir::makeFunction`. Heavy import-surface adds. | 2 days |
| `if.si` | 1 (`@if`) | Medium — `lowerExpr` × 3, `ir::makeIf`.  Cleanest IR-builder migration. | 0.5 day |
| `loop.si` | 1 | Medium — control-flow IR, loop-id management | 1 day |
| `match.si` | 1 | High — interacts with `expandMatchChain`, variant tag computation | 1 day |
| `control.si` | 3 (`@return`, `@break`, `@continue`) | Low — small handlers | 0.5 day |
| `logic.si` | 4 (logical ops) | Low — simple binary-op IR | 0.5 day |
| `bitwise.si` | 4 | Low — same shape as logic | 0.5 day |
| `cast.si` | 4 | Medium — type-driven dispatch | 1 day |
| `strings.si` | 1 | Low | 0.25 day |
| `operators.si` | 32 (`+`, `-`, …) | Per-instance Low; per-file aggregate — repetitive | 2 days |
| **Total est.** | **~63 declarations** | | **~10 working days** |

This is wall-clock estimate for a single focused engineer; parallelisable.

**Phase B continuation — extend the import surface (IR-handle ABI + more)**

The biggest remaining piece.  Migration of any non-trivial stratum
requires the import surface to cover the methods that stratum's body
uses.  The structurally heaviest part is the IR-handle ABI:

- **IR-handle table.** Each `&Compiler::ir::make*` host wrapper builds
  the JS IR object and returns an i32 handle into a host-side IR table.
  The firing code unpacks the result handle to recover the JS object
  and emit it into the lowered module.
- **AST field accessors.** Replace JS-side `node.name.name` dot-paths
  with import calls — `compiler_ast_field(node, field_name_id) →
  result_handle`.  Need careful handling of primitive-vs-object
  return distinction.
- **Remaining method surface** (mechanical, ~10 lines each):
  `ast::capture_template`, `ast::with_keyword`, `ast::with_name`,
  `ast::rewrite_call`, `ast::patch_types`, `ast::clone`,
  `type::bind_template_args`, `type::mangle_suffix`, `type::int`/`type::float`,
  `callee::name`, `module::push_definition`, `module::push_global`,
  `diag::error`, `diag::warn`, `watId`, `freshId`, `lowerExpr`,
  `lowerExprIfDefined`, `arg`, `choose`, `resolveType`, `isVarName`,
  `ctx::locals::set`, `ctx::globals::set`, `ctx::pendingLocals::push`.

Plus the `IR::*` dispatcher markers used by legacy strata bodies need
a parallel mechanism — they tell the loader what codegen kind a strata
produces.  In the new form, the strata's `register::keyword` already
sets `codegenKind: 'stratum_def'` and the `on::lower` handler's return
*is* the emitted IR.  So the `IR::*` markers go away during migration;
no new surface needed for them.

Realistic effort for full Phase B coverage: **3–5 days** of focused work.

**Phase E — retire the interpreter**
- Currently blocked on Phase D being complete: as long as some strata
  bodies live as inline blocks OR as legacy `@stratum_keyword` bodies,
  `compileHandlerBlock` / `compileBodyToDefExpander` /
  `compileBodyToExpanderFn` are needed.
- The mechanical work, *after* Phase D:
  1. Delete `src/elaborator/strataBody.ts` (~370 lines)
  2. Delete `src/elaborator/comptimeBuiltins.ts` (~140 lines)
  3. Remove the fallback path in `buildPhaseHandler` /
     `buildComptimeHandler` — every claimed handler must compile.
  4. Remove the `isRichBody` / `compileBodyToDefExpander` /
     `compileBodyToExpanderFn` references from `strataLoader.ts`.
  5. Drop `compileHandlerBlock` import from `src/comptime/imports.ts`'s
     `makeNamedHandler` wrappers.
  6. Re-run the suite; expect breakages only for tests that explicitly
     exercise the interpreter (e.g. `strataBody.test.ts` — delete it).
- Effort: ~1 day of cleanup once Phase D is done.

### Total realistic effort from where we are now

| Step | Effort |
|---|---|
| Phase B continuation (IR-handle ABI + remaining surface) | 3–5 days |
| Phase D (migrate ~11 .si files, ~63 declarations) | ~10 days |
| Phase E (delete interpreter, prune imports, tests) | ~1 day |
| **Total** | **~2–3 working weeks** |

This is the honest timeline.  Doing it incrementally is the right
approach: each migrated stratum tightens the noose, and the test suite
acts as the safety net the whole way.

### File map of the dissolution as it stands

| File | Role |
|---|---|
| `src/comptime/handles.ts` | HandleTable + StringPool (the ABI primitives) |
| `src/comptime/imports.ts` | Host import implementations (`compiler.*` namespace) |
| `src/comptime/engine.ts` | compileHandlerToWasm + compileStrataHandlers |
| `src/comptime/handles.test.ts` | 16 unit tests for handles |
| `src/comptime/engine.test.ts` | 8 end-to-end tests for compile-then-run |
| `src/elaborator/registry.ts` | `namedHandlers`, `strataHandlerFnNames`, `compiledHandlers` maps |
| `src/elaborator/strataLoader.ts` | Pre-pass for @fn bodies; bridge wrapper that checks cache first |
| `src/elaborator/strataBody.ts` | **Legacy interpreter** — kept until Phase D done |
| `src/elaborator/comptimeBuiltins.ts` | **Legacy comptime intrinsics** — kept until Phase D done |

---

**Spec reference:** This is the concrete realisation of tenet **T-7** from
`docs/strata-2.0-spec.html` ("Comptime is the long-arc goal") and the answer
to its open question §12 ("Compile-time evaluation scope").

---

## Problem

Today we have **two evaluators** for Silicon-shaped programs:

1. **The runtime evaluator** — WASM, executing the IR our compiler emits.
   Implicit, free, native to the platform.
2. **The strata body interpreter** — a small recursive AST walker in
   `src/elaborator/strataBody.ts`. Runs strata-side code at compile time.
   Knows about `@local`, a few builtins, scope-method dispatch, binary ops.

The two diverge by necessity:
- The runtime `@if` stratum emits WASM `(if ...)` instructions — it doesn't
  pick a branch, it builds IR.
- The compile-time `@if` has to actually *choose* one branch and evaluate it.

We've kept them in sync by hand. Nothing in the architecture prevents drift,
and every new operator/keyword has to be authored *twice* — once as a
runtime stratum, once as a comptime handler.

### The chicken-egg

Even within the comptime side, one form has to remain intrinsic to the
interpreter — `@if`. The reasoning: any "comptime handler that defines
`@if`" would itself need to branch internally, and at the level of the AST
walker, branching means JS `if`. So we hardcode one Silicon primitive in TS
to bootstrap.

This is a local minimum. The principled escape is to stop interpreting
strata bodies and start *compiling and running* them — the Zig model.

### Cost of staying

- Every new operator/keyword needs two implementations (lower + comptime).
- The interpreter has to grow indefinitely to support arbitrary comptime
  code: loops, recursion, closures, arrays, modules — each costs another
  TS-side switch case and another opportunity for drift.
- `@if`-as-intrinsic is permanent.
- Third-party (T2) strata can't be distributed as compiled artifacts — they
  must ship source the interpreter can walk.
- The claim "strata are programs, not data" is partially false: strata
  bodies are AST trees that a special evaluator walks, not real programs.

---

## Design tenets

The plan honours these — most carry over from the Strata 2.0 spec.

- **C-1. One evaluator.** The Silicon runtime *is* the comptime evaluator.
  No second implementation.
- **C-2. WASM is the floor.** WebAssembly provides primitives (`if`, `loop`,
  arithmetic, memory). Silicon defines everything above that as strata that
  lower to WASM. The "irreducible primitive" lives below Silicon, not in it.
- **C-3. Strata are programs, not data.** A `@stratum` body compiles
  through the normal pipeline (parser → elaborator → IR → WASM). The
  compile-time host invokes it as a function.
- **C-4. Self-hosting holds.** `./build.sh check` must still produce a
  byte-equal `stage1.wasm`. Whatever we do to comptime, the seed compiler
  has to bootstrap from itself.
- **C-5. T-5 still applies.** A failing strata body is a runtime trap with
  a structured diagnostic — same model as user code semantic errors.
- **C-6. Phased.** Stage 0 (TS host) lands first; stage 1 (self-hosted)
  catches up via a tractable migration.

---

## The Zig model

Zig has `comptime`:

```zig
const x = comptime fib(10);   // fib(10) runs at compile time
fn fib(n: u32) u32 { ... }    // the same fn runs at runtime too
```

How it works:
- `fib` is compiled like any function.
- At each call site flagged `comptime`, the compiler **runs** the compiled
  function and substitutes the result into the rest of compilation.
- There's no "comptime language" — comptime is the same language at a
  different phase.

We adopt the same shape:

| Zig | Sigil-Silicon |
|---|---|
| `comptime expr`     | Strata body, fired at compile time           |
| Native compiler runs the function | Sigil compiler runs the WASM      |
| Same `fn` syntax for both phases | Same `@fn`/`@local`/etc. syntax     |
| Host provides comptime stdlib   | Host exposes CompilerAPI as imports |

What's *specific to us* — and a real complication — is that the Sigil
compiler **runs as WASM** (under wasmtime). "Run the WASM at comptime"
therefore means *WASM hosting another WASM*. See §6.

---

## Architecture

```
                          ┌───────────────────────────────────┐
                          │  Outer host (wasmtime)             │
                          │                                    │
                          │  ┌──────────────────────────────┐  │
                          │  │  stage1.wasm                 │  │
                          │  │  (the Sigil compiler)        │  │
                          │  │                              │  │
                          │  │  src.si ──► parse ──► elab   │  │
                          │  │                       │      │  │
                          │  │                       ▼      │  │
                          │  │     event fires:             │  │
                          │  │     a stratum handler        │  │
                          │  │     needs to run             │  │
                          │  │                       │      │  │
                          │  │                       ▼      │  │
                          │  │     handler body (.wasm)     │  │
                          │  │     already compiled         │  │
                          │  │                       │      │  │
                          │  │                       ▼      │  │
                          │  │  ┌──────────────────────┐    │  │
                          │  │  │ embedded comptime    │    │  │
                          │  │  │ WASM engine          │    │  │
                          │  │  │                      │    │  │
                          │  │  │ instantiate(body)    │    │  │
                          │  │  │   imports = host's   │    │  │
                          │  │  │   CompilerAPI        │    │  │
                          │  │  │ call(args) → result  │    │  │
                          │  │  └──────────────────────┘    │  │
                          │  │                       │      │  │
                          │  │                       ▼      │  │
                          │  │     result returned;         │  │
                          │  │     elaboration resumes      │  │
                          │  └──────────────────────────────┘  │
                          └───────────────────────────────────┘
```

Components:

- **A. Strata-body compiler.** Lowers a `@stratum on::X { body }` block to a
  WASM function with a documented signature. Today's strata body
  interpreter goes away; this replaces it. The compiler is just the
  existing `lowerProgram` — the body is a regular Silicon program.

- **B. Comptime engine.** The thing that *executes* a compiled body inside
  the running compiler. Two implementations:
  - **Stage 0 (src/, TypeScript host):** use Bun's native
    `WebAssembly.instantiate` (already proven viable — see
    `src/codegen/toWasm.ts`).
  - **Stage 1 (boot/, self-hosted):** embed a minimal WASM interpreter
    inside `stage1.wasm`. See §6.

- **C. Compiler-as-imports surface.** Every existing CompilerAPI method
  (`ast::capture_template`, `module::push_definition`, `state`, …) becomes
  an importable WASM function the body links against. The host implements
  the imports against the live compilation context.

- **D. Handle table.** State handles, AST templates, type values — anything
  the body holds onto across multiple calls into the API — are stored
  host-side and exposed as opaque `i32` IDs.

---

## The compiler-as-imports surface

A strata body that today does:

```silicon
@local tmpl := &Compiler::ast::capture_template node, 'pre';
&Compiler::module::push_definition tmpl.ast;
```

…becomes, after this dissolution, a Silicon program that calls imported
functions:

```silicon
@extern compiler ast_capture_template (i32, i32) -> i32;
@extern compiler module_push_definition (i32) -> i32;

@fn handler node_id:Int := {
    @local tmpl_id := &compiler::ast_capture_template node_id, 0; # 0 = 'pre'
    &compiler::module_push_definition tmpl_id;
};
```

Notes:

- `node_id` is an opaque handle into the host's AST.
- `tmpl_id` is an opaque handle into the host's template table.
- String args (like `'pre'`) become integers (interned IDs) or are passed
  via a shared memory region the host can read.
- The full surface is mechanical: every method in `src/compiler-api/index.ts`
  gets a WASM signature, an import declaration, and a host-side implementation
  that translates handles back to live JS/Silicon objects.

Two design choices to make explicit:

1. **Handles vs. shared memory.** Handles are opaque integers; shared memory
   would let the body inspect AST structure directly. We pick **handles**
   for V1: simpler, safer, no need to define a stable AST binary layout.
2. **Synchronous calls only.** A body call is `instantiate → call → return`.
   No await, no continuation. Bodies that need long-running work (network,
   IO) belong out of scope until comptime IO is a separate design.

---

## Strata body compilation

Today's `@stratum` body has special forms the interpreter recognises:
`@local`, `&Compiler::*`, `&handle::method`, `node.field.field`, etc.

For "compile and run," the body becomes a regular Silicon program with a
well-known entry point. Each `on::X` handler becomes a `@fn`:

```silicon
@stratum Generics := {
    &Compiler::register::keyword '@generic';
    &Compiler::on::call_site Generics_call_site;
};

@fn Generics_call_site node_id:Int := {
    # ... body identical to today's, but compiled, not interpreted ...
};
```

Reuses everything:
- `@local` → real WASM local.
- `&compiler::*` → WASM import call.
- `&@if` → the existing `@if` stratum that lowers to WASM `(if ...)`.
- `node.field` → calls like `&compiler::ast_get_field node_id, 'field'`
  returning the child's handle.

The body's WASM is built **once** at registry-build time and cached. Each
firing of the handler is just an `instance.call(handler_export, args)`.

What this kills:
- The hardcoded `@if`/`@nil`/`@not`/operator switch in `strataBody.ts`.
- The "rich body interpreter" detection.
- The two-implementations-of-`+` problem.
- `compileHandlerBlock`, `compileComptimeHandler`, `compileBodyToDefExpander`,
  `compileBodyToExpanderFn` — all gone.

What this enables in strata bodies:
- Loops (`@loop`), recursion, closures (once the language gets them).
- Arrays, structs, full pattern matching.
- Calling helper `@fn`s defined in the same stratum file.
- Importing other strata's helpers (subject to tier rules).

---

## WASM-in-WASM: the comptime engine

The Sigil compiler runs *as* WASM. To execute a strata body, it needs to
run *another* WASM module. Options:

### Option A — Embed a tiny WASM interpreter

Vendor or write a small stack-machine WASM interpreter (~50–100 KB compiled)
and link it into `stage1.wasm`. The interpreter reads a `.wasm` byte
buffer (the strata body), walks its instructions, and calls back into
host-provided import functions when the body executes a `call $import`.

Pros:
- Self-contained. `stage1.wasm` doesn't need any non-standard WASI calls.
- Portable across every WASI runtime.

Cons:
- Adds binary size (~50–100 KB).
- Interpreter performance is ~10–100× slower than a JIT — fine for most
  strata, painful for any handler that fires on every node.
- Writing/vendoring a correct WASM interpreter is real work; reference
  implementations exist (e.g., a Silicon port of `wasm-interp` from wabt)
  but porting is non-trivial.

### Option B — Punch out to outer host via a WASI extension

The outer wasmtime instance hosts the strata-body execution; `stage1.wasm`
makes a non-standard WASI call like `wasi_comptime::eval_body(bytes, ...)`.
The outer wasmtime takes the bytes and instantiates them with imports
that proxy back to stage1.

Pros:
- Fast: outer wasmtime JITs both stage1 and the body.
- No binary growth in stage1.

Cons:
- Requires a custom wasmtime build or a plugin. Loses "any WASI runtime
  works" portability — a stated tenet of the project.
- Coupling between Sigil and wasmtime as a *modified* runtime.

### Option C — WASI Component Model

When/if the Component Model stabilises with the right primitives
(dynamic module instantiation), use it natively.

Pros:
- Future-proof, standards-based.

Cons:
- Not stable enough today.
- Limited tooling support.

### Decision

**Stage 0 (now, TS-backed):** Bun's `WebAssembly.instantiate` is the
comptime engine. Strata bodies compile to WASM bytes via `wabt`, get
instantiated, get called. Already proven by the `generic-monomorph` test.

**Stage 1 (self-hosted):** **Option A** — embed a minimal WASM interpreter
in `stage1.wasm`. We accept the size/performance cost in exchange for a
self-contained, portable bootstrap. Optimisations (small JIT, caching
instances across firings, precompiling host-frequent strata to native via
the outer wasmtime when available) are follow-up work.

**Long arc:** Option B/C if/when the ecosystem makes them tractable.

---

## Handle table

The host maintains tables for objects that strata bodies reference across
multiple calls:

- AST nodes: `i32 → AST node`
- Template handles: `i32 → TemplateHandle` (already exists per spec §5.5)
- Type values: `i32 → SiliconType`
- State buckets: `i32 → Map<string, value>`
- Diagnostics: append-only, no handles needed

Handles are allocated lazily as the body asks for them and freed when the
handler returns. (A handler's lifetime is one firing; persistence across
firings happens via the state-bucket mechanism, which is itself a
host-owned map.)

This is just the existing CompilerAPI shape with `any` replaced by `i32`
in the import signatures.

---

## Migration path

Five phases. Each is independently mergeable; the system stays green
between phases.

### Phase A — Strata bodies as first-class Silicon programs

- Allow `@stratum Name := { body }` to contain `@fn` definitions that the
  Strata 2.0 `register::*` calls can name as handlers:
  ```silicon
  @stratum Generics := {
      &Compiler::register::keyword '@generic';
      &Compiler::on::call_site Generics_call_site;
  };
  @fn Generics_call_site node:Int := { ... };
  ```
- These `@fn`s lower to WASM like any other.
- Keep the AST-walking interpreter alive for inline `{ ... }` blocks during
  the transition.
- **Verification gate:** every existing strata that today uses inline
  blocks can be rewritten in this form and still works. All 652 tests pass.

### Phase B — Define the import surface

- For each CompilerAPI method, write its WASM signature.
- Implement TS-side host functions that translate `i32` handles to live
  objects.
- Generate `@extern` declarations strata bodies can import.
- No behavioural change yet — the interpreter still runs bodies; the
  imports are tested via direct invocation.

### Phase C — Compile-then-run via Bun

- For strata bodies expressed in Phase-A form, route them through
  `lowerProgram` → wabt → `WebAssembly.instantiate`.
- Cache compiled bodies in the registry.
- Replace the interpreter path for these bodies with a real
  `instance.exports[name](handle)` call.
- Run all 652 tests under the new path. **Both paths exist** until every
  built-in stratum is migrated.

### Phase D — Migrate built-in strata

- `src/strata/*.si` and `boot/strata/builtin/*.si` are rewritten in the
  Phase-A form (no inline-interpreter blocks).
- The interpreter's call sites in `strataBody.ts` shrink to nothing.
- The hardcoded `@if`/`@nil`/operator switch in `strataBody.ts` becomes
  dead code.

### Phase E — Retire the interpreter

- Delete `src/elaborator/strataBody.ts`.
- Delete `src/elaborator/comptimeBuiltins.ts` (built-in comptime semantics
  for `@if`, `+`, `==`, etc. are now whatever the runtime strata for those
  forms compile to — i.e., WASM `if` + WASM `i32.add` + WASM `i32.eq`).
- Update `docs/strata-2.0-spec.html` §12 to mark the open question closed.

### Stage 1 catch-up

- Once stage 0 (TS) is fully on compile-then-run, port the comptime engine
  to Silicon (Option A — minimal WASM interpreter).
- The seed `stage1.wasm` ships with built-in strata as embedded pre-compiled
  WASM blobs (the existing `embedded_bundle.si` becomes binary-shaped).
- `./build.sh check` continues to verify byte-equal self-host.

---

## Risks

- **Performance.** Compile-then-run is slower per invocation than walking
  an AST. For handlers that fire on every AST node, this could meaningfully
  slow compilation. *Mitigations:* AOT-compile bodies at registry-build,
  cache instances, reuse a single instance per stratum with cleared state
  per firing.
- **Binary size.** Embedding a WASM interpreter in `stage1.wasm` adds size.
  *Mitigations:* keep it small; the alternative (Option B/C) waits on the
  ecosystem.
- **Debuggability.** A failing strata body is now buried in WASM, not in an
  AST we can pretty-print. *Mitigations:* emit DWARF or a source map for
  strata WASM; preserve source spans through lowering; have the host catch
  body traps and surface them with the original strata-source location.
- **Bootstrap complexity.** The seed compiler has to ship pre-compiled
  built-in strata. *Mitigations:* a single regeneration script; the
  byte-equal check protects us from drift.
- **Cyclic dependency in tooling.** "Strata bodies compile to WASM via the
  compiler, but the compiler needs the strata for `+`/`if`/etc." This is
  the *real* chicken-egg, and it's solved the same way self-hosting always
  is: bootstrap from a prior seed where the built-in strata are already
  compiled.

---

## What this unlocks

Direct wins:

- **One implementation per form.** `+` is defined once, in `operators.si`,
  and that one definition serves both runtime and comptime.
- **No interpreter to grow.** Loops, recursion, closures — anything that
  the language gains, comptime gets for free.
- **`@if` is no longer special.** It's a normal stratum that lowers to
  WASM `(if ...)`. Closed: the chicken-egg.
- **T2 strata as compiled artifacts.** A third-party stratum can ship as a
  `.wasm` file plus a small manifest. No source distribution required.

Indirect wins:

- Compile-time programming becomes real: types as values, conditional code
  emission, derive macros, comptime constants computed by arbitrary Silicon.
- The "strata is the product" claim becomes literal: a stratum is a Silicon
  program. End of story.
- Comptime errors fall under T-5 cleanly — they're runtime traps in the
  body's WASM, the host catches them, the user sees a structured diagnostic.
- Strata can call other strata's exported helpers (subject to tier rules)
  via normal `@use`.

---

## Open questions

- **Per-body memory.** Each strata-body WASM instance needs its own linear
  memory. Do we allocate a fresh one per firing, or share across firings
  within one compile? Likely the latter, reset between handler types but
  not between repeated firings of the same handler.
- **Comptime IO.** Should comptime code be able to read files, query
  environment, hit the network? Almost certainly not for V1; revisit if a
  build-tool use case forces it.
- **Comptime vs build-time.** Once comptime is full Silicon, the line
  between "build script" and "macro" blurs. We may want explicit phase
  annotations (`@@phase 'comptime'` vs `@@phase 'runtime'`) on definitions
  so users can reason about when their code runs.
- **Recursive compilation.** Can a comptime body trigger further
  compilation (e.g., synthesise a function, lower it, run it)? Spec'd by
  T-5 + module::push_definition today; needs revisiting under the new model.
- **Caching.** Can compiled strata bodies be cached across invocations of
  the compiler? Probably yes — content-addressed by source hash + compiler
  version.

---

## Worked example: `@generic` after the dissolution

Today (with the interpreter):

```silicon
@stratum Generics := {
    &Compiler::register::keyword '@generic';
    &Compiler::on::call_site {
        @local s := &Compiler::state 'stratum';
        @local callee := &Compiler::callee::name node;
        ...
    };
};
```

Today, the inline `{ ... }` block is *interpreted*. The runtime forms
inside it (`+`, `==`, etc.) are handled by built-in comptime handlers.
`@if` is intrinsic.

After the dissolution:

```silicon
@stratum Generics := {
    &Compiler::register::keyword '@generic';
    &Compiler::on::call_site Generics_call_site;
};

@fn Generics_call_site node:Handle := {
    @local s := &compiler::state 'stratum';
    @local callee := &compiler::callee_name node;
    &@if (&compiler::state_has s, callee), {
        ...
    };
};
```

- `Generics_call_site` lowers to WASM exactly like a user `@fn`.
- The host instantiates the stratum's compiled WASM at registry-build
  time. At each call site, it calls the exported `Generics_call_site`
  function with a node handle.
- `&@if` inside the body lowers to a WASM `(if ...)` — the SAME stratum
  used at runtime, no comptime/runtime split.
- `+`, `==`, etc. are also the same strata used everywhere else.
- No interpreter involved at any point.

This is what "T-7 closed" looks like.
