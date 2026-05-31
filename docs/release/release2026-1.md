# Release Notes — 2026-1

## Strata 2.0

Strata 2.0 is the extensibility overhaul that makes language features data
rather than code. Instead of adding a case to a switch in the compiler, you
register a *stratum* that declares tokens and attaches handlers to pipeline
phases. The compiler dispatches to those handlers automatically. Nothing in
`lower.ts` or `elaborator.ts` needs to know what `@derive` or `@generic` means.

The full implementation lives in `src/` (TypeScript prototyping layer). 56 tests
in `src/elaborator/strata2.test.ts` prove that generics, derive macros, and
trait-impl patterns can all be expressed as strata without any compiler
special-casing.

---

### Pipeline

```
Source → Parser → AST
                    ↓
              buildStrataRegistry   ← all @stratum defs evaluated;
                    ↓                  handlers compiled and stored
              ElaboratorRegistry
                    ↓
              elaborate(ast, registry)   ← fires on::decl, on::callSite,
                    ↓                      on::annotation during AST walk
              typecheck
                    ↓
              lowerProgram           ← fires on::lower per node;
                    ↓                  on::module_finalize at end
              IRModule → WAT / WASM
```

`buildStrataRegistry` and `lowerProgram` are the two load-bearing seams.
Everything Strata 2.0 does flows through those two call-sites.

---

### Strata tiers

Strata load in a fixed order so T0 builtins are always available to T1 user
strata before the user's program is processed.

| Tier | Source | Purpose |
|------|--------|---------|
| T0 | `src/strata/*.si` (bundled) | Builtins: `+`, `@if`, `@loop`, `@fn`, etc. |
| T1 | Inline `@stratum` defs in the user's program | User-defined keywords, operators, annotations |
| T2 | `extraSources[]` passed by the CLI | Strata plugins loaded from separate files |

---

### `@stratum` unified form

The `@stratum` keyword is the single entry point for all Strata 2.0 features:

```silicon
@stratum Counter := {
    &Compiler::register::keyword '@count';
    &Compiler::on::decl '@count', {
        &state::stratum::set 'seen', (&state::stratum::get 'seen') + 1;
    };
    &Compiler::on::module_finalize {
        &Compiler::diag::warn 'S9999', {}, "definitions seen: ...";
    };
};
```

The block body accepts these call forms:

| Call | Effect |
|------|--------|
| `&Compiler::register::keyword 'token'` | Register `token` as a valid definition keyword |
| `&Compiler::register::operator 'sym'` | Register `sym` as a valid operator |
| `&Compiler::register::annotation '@@tok'` | Register an annotation token |
| `&Compiler::on::decl 'token', { ... }` | Fire handler on Definition nodes |
| `&Compiler::on::call_site 'token', { ... }` | Fire handler at call-site expressions |
| `&Compiler::on::annotation '@@tok', { ... }` | Fire handler when annotation appears |
| `&Compiler::on::lower 'token', { ... }` | Fire handler during IR lowering |
| `&Compiler::on::module_finalize { ... }` | Fire handler once at end of module |
| `&Compiler::before 'OtherStrat'` | Declare ordering constraint |
| `&Compiler::after 'OtherStrat'` | Declare ordering constraint |

---

### Phase hooks

**`on::decl`**  
Fires in `lowerDefinition` when a Definition node's keyword matches the
registered token. The handler receives the full definition AST node and the
live `CompilerAPI`. Used to collect metadata, emit diagnostics, or push
derived definitions.

**`on::callSite`**  
Fires in `lowerBuiltinCall` when a call-site expression matches the registered
keyword. The handler can return an IR node to replace the call, enabling
keyword-level macro expansion.

**`on::annotation`**  
Fires in `lowerDefinition` after scanning the `annotations` array on a
Definition. The token is the annotation string (e.g. `'@@derive'`). The node
is the annotated definition. The primary mechanism for derive-style code
generation: `@@derive Eq` on a struct causes the stratum to emit an equality
function.

**`on::lower`**  
Fires during `lowerBuiltinCall` for the same token map. Exists alongside
`on::callSite` so strata can hook either the elaboration stage or the IR
lowering stage depending on what information they need.

**`on::module_finalize`**  
No token — fires once after all definitions have been lowered, just before
`lowerProgram` returns. Used for cross-definition patterns: emit all the
functions a `derive` annotation accumulated over the whole module, write a
dispatch table, generate trait vtables, etc.

Every compiled handler has `.__stratumName` tagged on it at registration time.
`fireHandlers` writes that name into `currentStratumRef` before invoking each
handler so that `state('stratum')` routes to the correct per-stratum bucket.

---

### State buckets

Two scopes with distinct lifetimes:

```typescript
api.state('stratum')   // same Map<string, any> for this stratum, whole compilation
api.state('instance')  // fresh Map<string, any> per handler invocation
```

`'stratum'` state is keyed by stratum name in `registry.stratumState`. The
routing works through a mutable ref object `currentStratumRef = { name }` that
is created once in `lowerProgram` and shared with the `CompilerAPI` closures.
Before each handler call, `fireHandlers` writes the handler's
`.__stratumName` into the ref. A plain string couldn't work here because
closures capture the reference at creation time, not the value.

`'instance'` state returns a fresh `Map` every call, providing scratch space
that never bleeds between handler invocations.

---

### Module mutation

```typescript
api.module.push_definition(def)           // append a raw AST Definition node
api.module.push_global(name, type, init)  // append an IRGlobal
```

Both write to `registry.pendingDefinitions`. At the end of `lowerProgram`,
after all top-level elements are lowered, that array is drained and each item
is lowered recursively. This is the mechanism for `derive`-style strata to emit
helper functions they synthesized during the module walk — the helpers appear
at the bottom of the module in final WAT output.

---

### Types-as-data (`api.type`)

```typescript
api.type.int                          // { kind: 'Int' }
api.type.float                        // { kind: 'Float' }
api.type.array(api.type.int)          // { kind: 'Array', element: { kind: 'Int' } }
api.type.variable('T')                // { kind: 'Variable', name: 'T' }
api.type.substitute(tmpl, bindings)   // replace Variable nodes with concrete types
api.type.equals(a, b)                 // structural equality check
api.type.infer_args(callNode)         // extract inferred types from a call's arg list
api.type.format(t)                    // 'Array[Int]', '(Int, Int) -> Bool', etc.
```

Together with the AST synthesis surface, this is the building block for
generics in Strata: capture the body template of `@generic Array T := { ... }`,
substitute `T → Int`, patch the inferred types of all cloned nodes, push the
specialized definition to `module.push_definition`.

---

### AST synthesis (`api.ast`)

```typescript
api.ast.capture_template(node, 'pre')      // deep-clone an AST subtree
api.ast.clone(handle)                      // another independent deep clone
api.ast.substitute(handle, { T: node })    // name-substitute in the AST clone
api.ast.patch_types(handle, bindings)      // rewrite inferredType fields in the clone
api.ast.span(node)                         // { file, line, col, length }
api.ast.doc(node)                          // doc comment string, or ''
```

`patch_types` is specifically needed for generics: after substituting type
variables in the AST, the `inferredType` annotations on the original tree are
stale. `patch_types` walks the clone and replaces any
`{ kind: 'Variable', name: 'T' }` with the concrete type from the bindings map,
making the clone ready to pass directly to `lowerExpr`.

`ast.span` accepts both `{ startLine, startColumn }` (real `SourceLocation`
from the parser) and `{ line, col }` (test-mock format), so strata body tests
don't need to construct full parser output.

---

### Diagnostics (`api.diag`) — T-5 model

`diag::error` and `diag::warn` append to `registry.diagnostics` and never
throw. The compiler always produces a complete output and accumulates all
errors, which are surfaced together at the end of the pipeline rather than
stopping at the first problem.

```typescript
api.diag.error('S0001', api.ast.span(node), 'expected Int, got Float', 'add a cast')
api.diag.warn ('S9999', api.ast.span(node), 'unused definition')
```

---

### T-6: T0 cycle detection

After all T0 strata are loaded, `detectT0Cycles` builds a directed graph from
`before`/`after` metadata and runs Kahn's algorithm. A detected cycle is broken
by removing the lexicographically-first edge and pushing a `S0001` diagnostic to
`registry.diagnostics`. The load order is always deterministic even with
malformed T0 strata.

---

## WASM binary emitter

A direct IR → WASM binary emitter has been added to `src/codegen/`:

| File | Role |
|------|------|
| `wasm-emitter.ts` | Main entry point: `emitWasmBinary(prelude, userMod)` |
| `wasm-buffer.ts` | Byte buffer with LEB128-aware write methods |
| `leb.ts` | Standalone LEB128 unsigned/signed encoders |
| `prelude-ir.ts` | Silicon runtime (`$alloc`, `$str_concat`, etc.) as IR nodes |

`compileToWasm` in `src/codegen/index.ts` uses this path instead of the
`compileToWat → watToWasm` round-trip, removing the wabt dependency for
binary output. The emitter targets byte-equality with the wat2wasm round-trip
as a strong correctness property — verified by `codegen.test.ts` on every
build.

### Bug fix: `$print_string` address tree

`prelude-ir.ts` was building the loop address in `$print_string` as
left-leaning `(ptr + 4) + i`, while `std.wat` writes right-leaning
`ptr + (4 + i)`. Both compute the same value but produce different stack
machine byte sequences. The prelude IR tree has been corrected to match
`std.wat`, restoring byte-equality at byte 422.

---

## Known issues

**`determinism > cross-process` test** (`tests/properties/determinism.property.test.ts:93`)  
The test spawns two child processes with `Bun.spawnSync(['bun', ...])`. If
`~/.bun/bin` is not on `$PATH` in the subprocess environment the spawn fails
with "Executable not found". Fix: replace `'bun'` with `process.execPath`
(the path to the currently-running bun binary). Tracked in
`bugs/determinism-test-bun-not-in-path.md`.
