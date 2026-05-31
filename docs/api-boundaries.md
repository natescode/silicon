# API Boundaries — Who Can Call What

This document defines the call-direction rules between compiler subsystems.
Violating these rules creates coupling that makes the compiler harder to evolve
and breaks the stability promises in `docs/stability.md`.

---

## Layer diagram

```
┌─────────────────────────────────────────────────────────┐
│  Consumers  (sgl CLI, LSP, test harnesses, IDE plugins) │
└───────────────────────────┬─────────────────────────────┘
                            │  import from src/api.ts only
┌───────────────────────────▼─────────────────────────────┐
│  Public CaaS API  (src/api.ts → src/caas/)              │
│  parse · buildRegistry · elaborate · typecheck · lower  │
│  compile · Workspace · Document · SemanticModel         │
└──┬──────────────┬──────────────┬────────────────────────┘
   │              │              │
   ▼              ▼              ▼
src/parser   src/elaborator  src/types       ← pipeline internals
src/grammar  src/modules     src/ir
src/ast      src/errors      src/codegen
src/fmt
```

**Direction of dependency: always downward.**  Upper layers import lower
layers; lower layers never import upper layers.

---

## Rules by subsystem

### Consumers (CLI, LSP, tools, user code)

- **May import:** `src/api.ts` exclusively.
- **Must not import:** anything under `src/` except `src/api.ts`.
- **Rationale:** `src/api.ts` is the stability boundary.  Everything inside it
  can be refactored freely without breaking consumers.

The `sgl` CLI (`src/sigil_cli.ts`) is a first-party consumer and follows this
rule.  The only legitimate internal imports in the CLI are for functionality
not yet exposed through the public API:

| Internal import | Why not in CaaS |
|---|---|
| `src/codegen` — `compileToWasm` | Binary emitter; no public wrapper yet |
| `src/codegen/qbe` — QBE tools | Native backend; CLI-only for now |
| `src/modules` — `loadModules` | File I/O; CLI builds the registry, passes it |
| `src/fmt/formatter` — `formatProgram` | Formatter reads `tree.program` (internal AST) |
| `src/errors/diagnostic` — `renderJson/Pretty` | Output formatting; not a pipeline stage |

Each of these is a candidate for promotion to the public API in a later minor
release.

### CaaS layer (`src/caas/`)

- **May import:** any internal compiler module.
- **Must not import:** consumer-level concerns (file I/O, process.exit, stderr).
- **Rationale:** CaaS functions are pure — given the same inputs they return the
  same outputs and never have side effects.  File I/O and process management
  belong in consumers.

### Pipeline internals (`src/parser`, `src/elaborator`, `src/types`, etc.)

- **May import:** sibling or lower internals.
- **Must not import:** `src/caas/` or `src/api.ts`.
- **Rationale:** internals are free to evolve; importing upward would create
  a circular dependency.

---

## Dependency graph (allowed imports)

```
src/api.ts
  └── src/caas/index.ts
        ├── src/parser/parser.ts
        ├── src/grammar/
        ├── src/ast/
        ├── src/elaborator/
        ├── src/types/typechecker.ts
        ├── src/ir/
        ├── src/codegen/
        ├── src/errors/diagnostic.ts
        └── src/modules/registry.ts

src/caas/workspace.ts
  └── src/caas/index.ts (CaaS pipeline functions)

src/sigil_cli.ts  (consumer — allowed internal imports listed above)
  ├── src/api.ts  ← CaaS pipeline
  └── (internal: codegen, qbe, modules, fmt, errors/diagnostic)
```

---

## Enforcement

There is no automated import-lint rule yet.  The convention is enforced by code
review.  A future minor release may add an ESLint rule that flags `src/caas/`
or `src/parser/` imports in consumer files.

---

## Promoting internals to the public API

When a consumer needs something that is currently internal:

1. Identify the minimal stable type/function shape.
2. Add it to `src/caas/index.ts` with a JSDoc `@public` marker.
3. Re-export from `src/api.ts`.
4. Document in `docs/compiler-as-a-service.md` and `docs/stability.md`.
5. The consumer switches to the public import.

Do not just add the internal import to the consumer — that defeats the boundary.
