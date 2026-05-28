# Sigil 1.0 Roadmap

> **Status:** This roadmap was authored when the Silicon-in-Silicon bootstrap
> lived under `boot/`. That tree has since been removed and the self-hosted
> compiler is slated for a future rewrite from scratch. Phases that refer to
> a "port to `boot/`" should be read as describing the future self-hosted
> compiler — the work needs to be re-scoped once the bootstrap rewrite
> begins. The TypeScript compiler in `src/` is the current production
> compiler.

## What 1.0 means

Sigil 1.0 is the release at which Silicon is demonstrably capable of writing
production-quality systems software — proven by the fact that the Sigil
compiler itself is written in Silicon, debuggable with standard tools,
error-safe, and ships native binaries without a runtime dependency.

The 1.0 release has four pillars:

1. **Language completeness** — the type system and standard library cover the
   surface area a systems programmer expects: structs, generics, error handling,
   unsigned integers, slices, and compile-time evaluation.
2. **Compiler capability** — Strata 2.0 in the self-hosted compiler, proving
   that language features are defined in Silicon rather than hard-coded in the
   compiler.
3. **Toolchain** — a native backend with debug info, a `sgl` CLI, and an LSP
   that gives IDE-level support in any editor.
4. **Distribution** — a user goes from zero to a running Silicon program in
   under two minutes using their favourite package manager.

Ten phases are ordered by dependency. Phases 1–2 establish the language
foundations that everything else builds on. Phases 3–6 are the Strata
workstream. Phase 7 is the Silicon interpreter. Phases 8–9 are compiler
infrastructure (native backend and debug tooling). Phase 10 is the distribution
and stability gate that turns the compiler into a shippable product.

The end state is a systems language with a unique extensibility story. Zig,
Rust, and C have no equivalent to Strata: user-defined keywords, operators, and
annotations that participate in the compilation pipeline at the AST and IR
level. That is the differentiator. These ten phases build the foundation that
makes that story credible to someone who would otherwise reach for Zig.

---

## Phase 1 — Language foundations

Two gaps must close before anything else: the type system is missing product
types, and the typechecker is opt-in. Both are load-bearing for every phase
that follows.

### 1a — Product types (`@struct`)

**What.** Silicon has sum types (`@type Shape := $Circle r:Int | ...`) but no
plain record type. A struct is a compound value with named fields and no
variant tag. Without it, every compound data structure requires a one-variant
sum, which is awkward and wastes the tag word.

`@struct` should be a Strata stratum — not a compiler change — that lowers to
a flat field layout:

```silicon
@struct Point := { x: Int, y: Int };
@struct Rect  := { origin: Point, size: Point };
```

Field access desugars to an offset load/store. `@comptime { size_of Point }`
returns `8`. The stratum emits constructor and accessor functions via
`module::push_definition`.

**Why first.** `Vec`, `HashMap`, and every other generic container type in
Phase 5 is built on structs. The compiler's own registry types (`StrataNode`,
`DefKindEntry`) need structs to be expressed cleanly. Phase 1 cannot be
declared complete until structs exist.

**Done when.** `@struct` is defined as a stratum in `src/strata/` (and in
the future self-hosted compiler when it lands). The compiler's internal
aggregate types are rewritten to use it. Field access compiles correctly
and the typechecker resolves field types.

### 1b — Typechecker always-on

**What.** The typechecker is currently opt-in (`--typecheck` flag). For 1.0,
type checking is the default. A language where you have to opt into type safety
is not a 1.0 position.

**What this requires.** An audit of the typechecker (`src/types/typechecker.ts`)
against the full Silicon surface: do all syntactic forms that a user can write
produce correct inferred types? Common gaps to check: struct field access (new
in 1a), generic instantiation, annotation-carrying definitions, and strata
bodies that produce IR with mismatched types. Any form that the typechecker
cannot handle yet must either be covered or be an explicit compile error rather
than a silent pass-through.

**Done when.** `--typecheck` is removed as an explicit flag and type checking
runs on every compilation. The compiler's Silicon sources (built-in strata
and stdlib under `src/strata/` and `src/stdlib/`) compile clean under the
always-on checker.

---

## Phase 2 — Error messages

**What.** An audit and rewrite of the 20 most common compile errors. Quality
of error messages is the single biggest determinant of whether people adopt a
language. The diagnostics infrastructure (span-accurate errors,
`registry.diagnostics`) already exists — this phase is about the content of
individual messages.

Each error must answer three questions: what was wrong, where exactly (file,
line, column, underline), and what to do about it. A message that says only
`type mismatch` fails all three. A message that says:

```
error[T0042]: cannot add Int and Float
  --> src/math.si:12:14
   |
12 |   @let total := count + ratio;
   |                 ^^^^^ Int
   |                         ^^^^^ Float
   = hint: use &@toFloat count to convert, or &@toInt ratio
```

passes all three.

**Scope.**

- Type mismatch errors: name the two types, show both source locations.
- Unknown keyword / operator: suggest the closest registered name.
- Missing return value: show the function signature and the inferred return.
- Arity errors: show the expected parameter list from the definition.
- Undefined name: show the nearest name in scope.
- Strata errors: `diag::error` messages from stratum code formatted the same
  way as compiler-native errors — same span display, same hint field.

**Done when.** The 20 most common errors from the test suite produce messages
that pass the three-question test above. Error format is documented in the
language reference.

---

## Phase 3 — Strata 2.0 in the self-hosted compiler

**What.** Port the Strata 2.0 implementation from `src/` (TypeScript) to
the future self-hosted compiler. The TypeScript implementation is the
complete reference: 56 tests in `src/elaborator/strata2.test.ts` specify
every behaviour.

**Why now.** Every subsequent phase depends on Strata 2.0 being available in
the self-hosted compiler. `@defer`, generics, and `@comptime` are all strata —
they cannot be built until the machinery that runs strata is self-hosted.

**Key additions** (in the future self-hosted compiler's compiler_api / strata
loader / elaborator):

- `currentStratumRef` mutable ref — allows `state('stratum')` to route to the
  correct per-stratum state bucket during handler execution. A plain string
  field does not work because closures capture the reference at creation
  time, not the value.
- `.__stratumName` tagging on compiled handlers in the strata loader — set
  before each handler is invoked, cleared after.
- `state('stratum')` and `state('instance')` routing using `registry.stratumState`.
- `module::push_definition` and `module::push_global` accumulator in the
  elaborator, drained at end of `lowerProgram`.
- `ast.capture_template`, `ast.clone`, `ast.substitute`, `ast.patch_types`
  in compiler_api.
- `type.variable`, `type.substitute`, `type.equals`, `type.format` in
  compiler_api.
- `diag::error` and `diag::warn` accumulator (T-5 model) — never throws,
  appends to `registry.diagnostics`.
- T-6 cycle detection on the T0 strata DAG in the strata loader.

**Also: Strata authoring guide.** The first user-facing documentation for
writing strata ships alongside Phase 3. It covers: the `@stratum` unified form,
all five phase hooks, the `state` API, `module::push_definition`, how to test a
stratum, and the stability contract for the `CompilerAPI` surface. This is the
document that makes a third-party strata ecosystem possible.

**Done when.** The 56 behaviours specified in `src/elaborator/strata2.test.ts`
can be expressed as self-hosted Silicon test cases and all pass under
`wasmtime`. The strata authoring guide is published.

---

## Phase 4 — `@defer`

**What.** A stratum that implements cleanup semantics: `@defer expr` schedules
`expr` to execute when the enclosing function returns, regardless of which
return path is taken. Mirrors Zig's `defer` / `errdefer`.

**Why now.** This is the first concrete payoff of Phase 3 and the simplest
possible proof that Strata 2.0 can express control-flow features without
compiler changes. It also has immediate practical value: the compiler itself
uses manual arena cleanup today that `@defer` would make safer.

**Implementation sketch.**

```silicon
@stratum Defer := {
    &Compiler::register::keyword '@defer';
    &Compiler::on::decl '@defer', {
        ;; append the deferred expression to a per-function list in stratum state
        &Compiler::state::stratum::get 'deferred_' + node.enclosingFn
            |> &list::push node.binding.expression;
    };
    &Compiler::on::module_finalize {
        ;; for each function that has deferred expressions, append them
        ;; as a cleanup block after the function body
        ...
    };
};
```

**Done when.** `@defer arena_free ptr;` works inside Silicon functions in the
compiler source. The compiler's own arena cleanup is rewritten to use it.

---

## Phase 5 — Generic stdlib + type system extensions

### 5a — Generic stdlib types

**What.** `Result`, `Option`, `Vec`, and `HashMap` implemented as Silicon
source using Strata 2.0 generics. These are library types, not compiler
features.

```silicon
@generic Result T, E := $Ok value:T | $Err error:E;
@generic Option T    := $Some value:T | $None;
@generic Vec    T    := { ... };    ;; growable array over an allocator
@generic HashMap K, V := { ... };   ;; open-addressing hash table
```

`@try` and `?` unwrap shorthand are `on::callSite` strata that desugar to
`@match` on the `Result` / `Option` arms. The compiler never needs to know
`Result` exists — it is pure library code.

**Done when.** The compiler's internal data structures (`registry.operators`,
handler maps, string arenas) are rewritten using these types. A Silicon program
that uses `Result` for file I/O and `Vec` for dynamic arrays compiles and runs
correctly.

### 5b — Unsigned integer types

**What.** `u8`, `u16`, `u32`, and `u64` as first-class types. Systems
programming requires them constantly: byte buffers, WASI struct fields, network
protocol parsing, memory addresses, bitmasks. The current model (everything is
`Int` / `Int64`, use careful casting) is workable but produces unsafe code.

Unsigned types are registered via Strata as distinct types with their own
operator overloads (unsigned division, unsigned right shift, unsigned
comparisons). They map to `i32` and `i64` at the WASM level — no new WASM
value types needed. The type system distinguishes them; the codegen uses the
`_u` variants of WASM instructions where applicable.

**Done when.** WASI bindings in `src/strata/modules/wasi_snapshot_preview1.si`
use `u32` and `u64` correctly. Existing code that casts `Int` for WASI fields
is rewritten to typed unsigned values.

### 5c — Slices

**What.** A slice is a fat pointer — a `(ptr: u32, len: u32)` pair — as a
first-class type. Without slices, every function that takes a subrange of an
array or string must accept separate pointer and length arguments, and there is
no way to express "a view into the middle of a buffer" safely.

```silicon
@let sum slice:Slice[Int] := {
    @var total:Int := 0;
    @loop i := 0; i < slice.len; i = i + 1; {
        total = total + slice[i];
    };
    total
};
```

`String` is already a length-prefixed byte buffer — a `Slice[u8]` is the
natural generalisation. The `@struct` from Phase 1 provides the representation;
the slice stratum adds bounds-checked index syntax via `on::callSite`.

**Done when.** Functions throughout the compiler that pass `(ptr, len)` pairs
as separate arguments are refactored to `Slice[u8]`. Bounds-checked indexing
works and emits a trap on out-of-bounds access.

### 5d — First-class functions

**Decision point.** Can a Silicon program store a function in a variable, pass
it to another function, or return it from a function?

WASM has `funcref` and the `call_indirect` instruction. First-class functions
in Silicon map to a `funcref` table index at the WASM level — the type system
tracks the function signature, and the stratum emits an indirect call via the
table.

This is required for: iterators (`vec.map`, `vec.filter`), event handlers,
callbacks to host code, and any generic algorithm that takes a comparator. It
is also required for traits/interfaces (Phase 6), which need method dispatch.

**Decision:** First-class functions ship in 1.0. A post-1.0 deferral leaves
too large a gap in library design. The WASM mechanism is well-defined; the
implementation is a stratum that manages a function reference table and emits
`call_indirect`.

**Done when.** A Silicon function can be bound to a variable of function type
and called through that variable. The `Vec` type from 5a exposes a `map`
function that takes a callback.

---

## Phase 6 — `@comptime` and build system

### 6a — `@comptime`

**What.** Generalize the Strata body interpreter — currently gated behind the
`@stratum` syntax — into a `@comptime` keyword available in ordinary Silicon
code. A `@comptime` block executes at compile time with access to the live
`CompilerAPI`.

**Why this is stronger than Zig's comptime.** Zig's `comptime` evaluates
arbitrary expressions at compile time but cannot inspect or mutate the AST.
Silicon's `@comptime` evaluator already has a live `CompilerAPI`, so
`@comptime` blocks can call `api.module.push_definition` to emit new IR,
inspect types via `api.type`, and read AST structure via `api.ast`. This is a
strictly more general capability.

**What it enables.**

- Compile-time dispatch table generation (replace the hardcoded opcode tables
  in the emitter with `@comptime`-generated arrays).
- Compile-time constants derived from struct layouts or type sizes.
- Zero-overhead generics: specialization happens at compile time, no runtime
  type erasure.
- Compile-time verified invariants: `@comptime { @assert size_of Point == 8; }`.

**Implementation path.** The Strata body interpreter (`src/elaborator/`)
already evaluates Silicon expressions against a `CompilerAPI`. The change is:
expose the same evaluator when the parser encounters `@comptime { ... }` in
user code. The evaluator needs no changes — only the dispatch path that decides
when to invoke it.

**Done when.** The compiler's opcode table (in the WAT emitter) is generated
by a `@comptime` block rather than hard-coded data. At least one
`@comptime { @assert ... }` invariant check exists in the compiler source.

### 6b — `sgl` CLI and project manifest

**What.** The `sgl` command-line tool replaces the current shell scripts as the
primary interface to the Silicon toolchain. It understands a project manifest
(`sgl.toml` or `build.si`) that declares the project name, source root,
dependencies, and target.

**The two commands that define the 1.0 user experience:**

```
sgl init        # scaffold a new Silicon project with a hello-world main.si
sgl run         # run via the interpreter for development; --release compiles via QBE
```

Running `sgl init && sgl run` in an empty directory must produce:

```
Hello, world!
```

in under two minutes on a fresh install with no manual configuration. That is
the acceptance test for the entire toolchain.

**`sgl init` output.**

```
my-project/
├── sgl.toml          # name, version, entry point
└── src/
    └── main.si       # @extern print x:Int; @let main := { &print 72; }
                      # — or a proper string print once stdlib ships
```

**Additional `sgl` subcommands for 1.0.**

| Command | What it does |
|---------|-------------|
| `sgl build` | Compile to the default target (native via QBE on POSIX, WASM otherwise) |
| `sgl run` | Execute via interpreter (development); `--release` compiles and runs via QBE |
| `sgl test` | Run all `@@test`-annotated functions via interpreter |
| `sgl eval` | Read-eval-print loop (REPL) backed by the interpreter |
| `sgl check` | Type-check only, no output |
| `sgl add <pkg>` | Add a dependency from the package registry |
| `sgl fmt` | Format Silicon source files |

**Package manifest.** `sgl.toml` is minimal:

```toml
[package]
name    = "my-project"
version = "0.1.0"
entry   = "src/main.si"

[dependencies]
silicon-std = "1.0"
```

Dependencies are fetched from a Git-backed registry. The lock file
(`sgl.lock`) pins exact commits. No package registry server is required for
1.0 — a GitHub-hosted index file is sufficient.

**Done when.** `sgl init && sgl run` produces "Hello, world!" on Linux and
macOS (Windows users via WSL). `sgl test` runs the Silicon standard library
test suite. `sgl add` can fetch and use a simple third-party package.

---

## Phase 7 — Silicon interpreter

**What.** A tree-walking interpreter for Silicon, written in Silicon, that
executes Silicon programs directly from the AST without emitting WAT or
compiling to native. It is the engine behind `sgl run`, `sgl test`, and
`sgl eval`.

**Why this is the right phase order.** The interpreter is simpler to build than
the native backend (no code generation, no platform ABI, no linker), yet it
unlocks more of the 1.0 user experience than any other single piece. With the
interpreter in place, `sgl run` works on every platform immediately — including
Windows without WSL — long before the QBE native backend lands in Phase 8.

**What the interpreter enables.**

- **`sgl run` development mode.** No compile step. Edit `main.si`, run
  `sgl run`, see output. Iteration loop is fast enough for interactive
  development.
- **`sgl test`.** `@@test`-annotated functions run via the interpreter. No
  native binary needed. Test discovery and reporting are entirely Silicon.
- **`sgl eval` / REPL.** Read a Silicon expression, evaluate it under the
  interpreter, print the result. Useful for exploring APIs and debugging
  expressions interactively.
- **`build.si` project manifests.** The interpreter can execute a `build.si`
  file directly — a Silicon program that describes how to build the project.
  No separate manifest DSL, no TOML parser: `build.si` is just Silicon.
- **Silicon-native debugging.** The interpreter sees Silicon values as Silicon
  values, not as raw WASM integers. A `Result[T, E]` is a tagged variant, not
  an `i32` tag plus an `i32` payload. A `Vec[Int]` is a Silicon record with
  named fields, not a raw pointer. Strata state is live and inspectable. This is
  the primary debugging tool for Silicon code through 1.0.

**Architecture.**

The interpreter is a visitor over the elaborated AST (post-strata, post-type-
check). Values are represented as tagged Silicon variants — the interpreter's
own internal `Value` type is itself defined using `@type`:

```silicon
@type Value :=
    $VInt   n:Int
  | $VFloat f:Float
  | $VStr   s:String
  | $VBool  b:Int
  | $VTuple fields:Vec[Value]
  | $VFn    params:Vec[String], body:AST, env:Env
  | $VUnit;
```

Environment frames are `HashMap[String, Value]` chains (cons list for closure
capture). Function calls push a new frame; returns unwind it. The interpreter
needs no garbage collector — Silicon's arena allocator already handles memory.

**Strata bodies run in the interpreter.** The Strata body evaluator
(`src/elaborator/`) is already an interpreter for a subset of Silicon.
Phase 7 generalises that evaluator to cover the full Silicon surface. The
`CompilerAPI` callbacks (`&Compiler::*`) remain the boundary between interpreted
user code and compiler internals.

**Scope boundary.** The interpreter targets correctness and development-loop
speed, not production performance. `sgl run --release` routes to the full
compile + QBE pipeline (Phase 8). Programs that need native speed should use
`sgl build`; the interpreter is not a runtime deployment target.

**No new dependencies.** The interpreter is pure Silicon. It requires no
additional C libraries, no WASM runtime beyond what already ships with `sgl`.
On POSIX it runs the WASM stage1 under wasmtime (the current model); once the
QBE backend is done, the interpreter itself runs natively.

**Done when.**

- `sgl run src/main.si` executes a Silicon program that prints to stdout.
- `sgl test` finds and runs `@@test` functions and reports pass/fail.
- `sgl eval` accepts Silicon expressions interactively.
- The Sigil compiler's test suite passes when driven through `sgl run`
  rather than the WASM pipeline.
- A Silicon-native debugger step (print a `Result[Int, String]` value as a
  Silicon tagged union, not as raw integers) works from `sgl eval`.

---

## Phase 8 — Native backend via QBE

**What.** `sgl build --target=native` produces a runnable native binary from
Silicon source without requiring wasmtime at runtime. The native backend targets
POSIX systems only for 1.0 (Linux and macOS); Windows users run under WSL.

**Backend: QBE.**

QBE is a small compiler backend (~13,000 lines of C, ~400KB) designed to be
embedded in exactly this kind of project. It accepts a simple textual IR,
performs register allocation and instruction selection, and emits assembly for
x86-64 and ARM64. The system assembler (`as`) and linker (`ld`) handle the
rest. No LLVM installation required.

```
Silicon IR → QBE IR text (.ssa) → qbe → .s → as → .o → ld → binary
```

QBE is bundled inside the `sgl` binary — users have no new dependencies beyond
a system linker, which every POSIX machine already has. `--target=wasm`
continues to use the existing WAT emitter unchanged.

**QBE IR emission.**

Silicon's typed IR maps directly to QBE IR. The correspondence is close enough
that the emission layer is mechanical:

| Silicon IR | QBE IR |
|-----------|--------|
| `Const i32 42` | `%r =w copy 42` |
| `BinOp i32.add left, right` | `%r =w add %left, %right` |
| `LocalGet name` | `%name` (already a value) |
| `LocalSet name, val` | store to stack slot or direct assignment |
| `Call callee, args` | `%r =w call $callee(w %a, ...)` |
| `If cond, then, else` | `jnz %cond, @then, @else` basic blocks |
| `Loop id, cond, body` | `@loop` / `@body` / `jmp @loop` labels |
| `Return val` | `ret %val` |

QBE uses typed temporaries (`w` = 32-bit, `l` = 64-bit, `s` = float) that
match Silicon's `i32`, `i64`, and `f32` value types directly.

**Calling conventions.**

QBE handles System V AMD64 ABI (Linux x86-64), AAPCS64 (Linux ARM64), and
Apple's ARM64 ABI (macOS on Apple Silicon) automatically. No manual register
assignment or ABI implementation needed.

**Platform support.**

| Platform | Architecture | Status |
|----------|-------------|--------|
| Linux | x86-64 | Tier 1 |
| Linux | ARM64 | Tier 1 |
| macOS | ARM64 (Apple Silicon) | Tier 1 |
| macOS | x86-64 | Tier 1 |
| Windows | — | WSL (Tier 2) |

**Post-1.0 upgrade path.** QBE optimizes well for a compiler of this size but
does not reach LLVM's optimization level. If optimization becomes a priority
post-1.0, the Silicon IR → text IR emission layer is structurally the same for
both QBE and LLVM IR — swapping backends is a matter of changing the text
format, not redesigning the pipeline.

**Done when.** `sgl build --target=native` on the Sigil compiler source
produces a native `sigilc` binary on Linux x86-64, Linux ARM64, macOS ARM64,
and macOS x86-64 that passes all existing tests and produces byte-identical
WAT output to the WASM path.

---

## Phase 9 — DWARF debug info and LSP

### 9a — Native debug info

**What.** The native backend emits line number information so GDB and LLDB can
set breakpoints by Silicon source file and line number and show Silicon function
names in stack traces.

**Two debug surfaces, two tools.**

For Silicon-level debugging — inspecting `Result[T, E]` values, stepping
through `@comptime` expansion, examining Strata state — use `sgl eval` and the
Phase 7 interpreter. The interpreter is the right tool here because it operates
on Silicon semantics, not WASM integers.

For low-level debugging of the native `sigilc` binary itself (register values,
assembly stepping, crash post-mortems), use GDB or LLDB with QBE-generated
debug info. That is what this phase delivers.

**Implementation with QBE.** QBE propagates `dbgfile` / `dbgloc` directives as
`.loc` assembler directives in the `.s` output. The assembler and linker produce
`.debug_line` DWARF sections automatically. The parser already attaches
`sourceLocation` (file, startLine, startColumn) to every AST node — threading
those locations through IR nodes to QBE `dbgloc` calls is the implementation
work. `DW_TAG_subprogram` records for function names can be emitted directly as
assembler directives in the `.s` output.

This gives source-level line numbers and Silicon function names — the 80% case.
Full variable inspection via DWARF (`DW_TAG_variable`) is a post-1.0
improvement; the interpreter covers that need in the meantime.

**Done when.** Running `gdb sigilc` and setting a breakpoint on
`lowerDefinition` by Silicon source file and line number works. Stack traces
name Silicon functions. Breakpoints survive a recompile.

### 9b — Language server (LSP v1)

**What.** A Silicon language server implementing the Language Server Protocol,
giving IDE-level support in VS Code, Neovim, Helix, and any other LSP-capable
editor. The existing plan is documented in `docs/language-server-plan.html`.

**v1 capability set (1.0 scope).**

| Capability | What it provides |
|-----------|-----------------|
| Diagnostics | Parse and type errors appear inline as you type |
| Go to definition | Jump to the definition of any name |
| Hover | Show inferred type and doc comment for any expression |
| Syntax highlighting | TextMate grammar for all Silicon tokens |
| Document symbols | Outline of functions and type definitions |

Full strata-aware autocomplete (completing registered keywords and operators
from the active strata) and cross-file reference tracking are post-1.0.

**Done when.** The VS Code extension and a standalone `sgl lsp` command are
published. Diagnostics, go-to-definition, and hover work on the Sigil compiler
source itself.

---

## Phase 10 — Stability, spec, and distribution

This phase has no code deliverables. It is the gate that turns a capable
compiler into a shippable product.

### 10a — Grammar specification

A formal grammar document (EBNF) defining exactly what Silicon parses,
separate from what strata add to it. This document must exist before 1.0 for
three reasons: it makes it possible to write a second implementation (a
formatter, a linter, an alternative backend) without reverse-engineering the
parser; it defines what "grammar stability" means concretely; and it is the
canonical reference for contributors modifying the parser.

The grammar is already small and stable (CLAUDE.md: "DO NOT change the grammar;
Grammar changes are last-resort"). Formalising it is documentation work, not
design work.

### 10b — Language stability policy

A written policy declaring what is stable at 1.0 and what the rules are for
breaking changes. Three surfaces need explicit treatment:

- **The Silicon grammar** — stable at 1.0; changes require a deprecation
  period and a version bump.
- **The standard strata (`@defer`, `Result`, `Vec`, etc.)** — stable API;
  internal implementation may change.
- **The `CompilerAPI` surface** — stable contract for stratum authors; new
  methods may be added, existing ones may not be removed without a major version.

### 10c — Installation and distribution

**The acceptance test for 1.0 distribution:**

```
brew install sigil        # or: apt install sigil, winget install sigil, ...
sgl init && sgl run
```

Must produce `Hello, world!` — no manual PATH edits, no wasmtime installation,
no cloning the repository.

**Platform targets.**

| Platform | Tier | Notes |
|----------|------|-------|
| Linux x86-64 | 1 | CI-tested; binary on every release |
| Linux ARM64 | 1 | CI-tested; binary on every release |
| macOS ARM64 (Apple Silicon) | 1 | CI-tested; binary on every release; Homebrew formula |
| macOS x86-64 | 1 | CI-tested; binary on every release |
| Windows x86-64 | 2 | Via WSL; no native Windows binary for 1.0 |
| WASI | 2 | `stage1.wasm` continues to ship for embedded/browser use |

**Distribution channels.**

- GitHub Releases: prebuilt tarballs / zip for all Tier 1 targets.
- Homebrew tap: `brew install sigil/tap/sigil`.
- `apt` / `deb` package for Ubuntu/Debian LTS.
- `winget` manifest for Windows.
- A shell installer (`curl https://sigil-lang.org/install | sh`) for the
  one-liner case.

The `sgl` binary is self-contained: it embeds `stage1.wasm` as a fallback
compiler and invokes wasmtime from a bundled copy if LLVM is not present. A
fresh install works immediately with no external dependencies.

---

## Definition of done for 1.0

A Sigil 1.0 release is ready when all ten phases are complete and every item
in this checklist holds simultaneously.

**Language**
- [ ] `@struct` is defined as a stratum; the compiler's aggregate types use it.
- [ ] The typechecker runs on every compilation with no opt-in flag required.
- [ ] `u8`, `u16`, `u32`, `u64` are first-class types with correct unsigned codegen.
- [ ] Slices (`Slice[T]`) exist and are used in place of raw `(ptr, len)` pairs.
- [ ] First-class functions work; `Vec` exposes a `map` taking a callback.
- [ ] `Result`, `Option`, `Vec`, `HashMap` are in the standard library.
- [ ] `@defer` is implemented as a stratum and used in the compiler source.
- [ ] `@comptime` works; the compiler's opcode table is generated by it.

**Compiler**
- [ ] `./build.sh check` passes (byte-equal self-hosting gate).
- [ ] `sgl build --target=native` produces a native `sigilc` that passes all tests.
- [ ] GDB / LLDB can set breakpoints on `sigilc` at the Silicon source level (line numbers).
- [ ] The 20 most common errors produce actionable messages with source spans.

**Interpreter**
- [ ] `sgl run src/main.si` executes a Silicon program directly (no WAT, no native binary).
- [ ] `sgl test` finds and runs `@@test` functions via interpreter; reports pass/fail.
- [ ] `sgl eval` accepts Silicon expressions at a REPL and prints results.
- [ ] `Result[T, E]` and `Vec[T]` values are displayed as Silicon types in `sgl eval`,
      not as raw integers.
- [ ] The Sigil compiler's test suite passes when driven via `sgl run`.

**Toolchain**
- [ ] `sgl init && sgl run` produces "Hello, world!" on Linux and macOS
      within two minutes of a fresh install (Windows via WSL).
- [ ] `sgl test` runs `@@test`-annotated functions.
- [ ] `sgl add` can fetch a simple third-party package.
- [ ] The LSP v1 is published; diagnostics, go-to-definition, and hover work.

**Stability and documentation**
- [ ] The Silicon grammar is published as a formal EBNF document.
- [ ] The language stability policy is published.
- [ ] The strata authoring guide is published.
- [ ] A getting-started tutorial takes a new user from install to a working
      Silicon program in under 15 minutes.

**The proof.** The claim of Sigil 1.0 is not "here is a complete language." It
is: "here is a language toolkit whose own standard features are implemented in
the extension mechanism, and that mechanism is powerful enough to build
production software." That is the claim no existing systems language can make.
The checklist item that proves it: `@@derive Eq` (or equivalent) ships as a
stratum in the standard library, implemented entirely in Silicon, with no
compiler special-casing.
