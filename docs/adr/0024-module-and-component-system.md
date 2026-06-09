# ADR 0024 — Component / module / file: a three-tier system named in WASM Component-Model vocabulary

- **Status:** Accepted — **implemented** (Stage A + Stage B; post-v1.0 items deferred, see *Implementation status*)
- **Date:** 2026-06-07 (implemented 2026-06-08)
- **Deciders:** NatesCode
- **Related:** ADR 0023 ([0023-language-identity-and-non-goals.md](0023-language-identity-and-non-goals.md) — `::` is namespacing only, no methods/UFCS, low-ceremony) · ADR 0020 ([0020-odin-inspired-grammar.md](0020-odin-inspired-grammar.md) — "bare = common, `@` = reserved"; the §decision-8 signature-line modifier slot this **amends**) · ADR 0010 ([0010-grammar-targets-ll1.md](0010-grammar-targets-ll1.md) — LL(1)) · ADR 0014 ([0014-global-local-bindings.md](0014-global-local-bindings.md) — `@global`/`@local`; this ADR **extends** it with init order) · ADR 0015 ([0015-object-capabilities.md](0015-object-capabilities.md) — no ambient authority) · ADR 0013 ([0013-capability-checker-bootstrap.md](0013-capability-checker-bootstrap.md) — `on::check`, mint-site restriction, `symbol_module`) · ADR 0008/0009 ([0008-memory-management-arenas.md](0008-memory-management-arenas.md), [0009-wasm-gc-target.md](0009-wasm-gc-target.md) — whole-program memory mode) · ADR 0001 ([0001-generic-monomorphization-scope.md](0001-generic-monomorphization-scope.md) — monomorphization, a prerequisite for WIT type-mapping) · `../use-includes.md` (the shipped `@use` concatenation model) · `../lockfile-format.md` (`sgl.lock` / `[dependencies]`) · `../grammar.ebnf` (the contract this honors)

## Context

Silicon today has **one flat global namespace** with **no per-file privacy** and no
package/namespace tier. Two facts from the shipped compiler frame everything below:

1. **`@use` is a pre-parse textual concatenation preprocessor.** `useResolver.ts`
   (`compiler/src/modules/useResolver.ts`) visits files depth-first, dedups by fs
   path or `std:<rel>`, detects cycles, swaps wasm-gc shadow variants
   (`wasmGcShadowPath`), and **strips the directives before parsing** — "everything
   ends up in one global namespace as if the user had concatenated by hand"
   (`../use-includes.md` §Semantics, item 4 "No namespacing yet"). It is *not* a
   grammar construct (`../grammar.ebnf` §Legacy / the `@use` directive note: "`@use`
   is NOT a grammar construct"). Crucially, there is **no directory-glob
   auto-inclusion today**: `@use` is the *only* mechanism that pulls a sibling like
   `greeting.si` into `main.si`.

2. **`::` is purely a namespacing qualifier, with two distinct resolution paths.**
   It is lexed as `nsSep`, parsed into a `Namespace` node carrying `path: string[]`
   (`parser.ts` `parseNamespace()`). It resolves down **two** separate paths:
   - **Registry-backed env/user modules.** `web::`, `JSString::`, `console::`,
     `wasi_snapshot_preview1::`, and user `modules/` wrappers are string-joined and
     looked up in a **flat** `ModuleRegistry` (`Map<string, ModuleEntry>`,
     `compiler/src/modules/registry.ts`) — two layers, `kind:'env'` (from
     `compiler/src/strata/modules/*.si`) and `kind:'user'` (from
     `<projectDir>/modules/`), with **env winning on collision**
     (`compiler/src/modules/loader.ts`).
   - **Compiler intrinsics.** `WASM::` and `IR::` are **intrinsic-only
     pseudo-modules with no registry entries**; they are resolved *before* the
     registry by the intrinsic dispatch in `lower.ts` (operator stratum →
     `WASM::*`/`IR::*` instruction), never via `ModuleRegistry`.

   At IR-lower, `callName()` joins `Namespace.path` with `::`; cross-module calls
   merge into the single core module as direct calls named `module__function`
   (double-underscore; `lower.ts`), and `watId()` maps `::` → `_`
   (`web::console_log` → `web_console_log`). `ModuleEntry.functions` is keyed by
   **bare** name; nested `foo::bar::baz` paths are impossible without rewriting that
   storage. Note the first WASM-import field is *already* module-named in shipped
   code (`web`, `wasm:js-string`/`js-bridge` for `JSString`, etc. via
   `IMPORT_ENV_OVERRIDE`), not just `"env"` — this is supporting evidence for the
   flat-module → first-field mapping below.

The shipped greeter (`examples/greeter/src/{main.si,greeting.si}`) is the canonical
shape: two files in one `src/` dir, `@use 'greeting.si';`, sharing scope. `sgl.toml`
carries `[package] name/version/entry` and a `[dependencies]` stub
(`name = "path:<rel>"`, **double-quoted** — `readSglToml`'s kv regex only matches
double quotes); `sgl.lock` uses a separate `[[package]]` array-of-tables / `source`
shape (`../lockfile-format.md`).

The WASM Component Model (the vocabulary this ADR adopts) **strictly nests** a core
**MODULE** *inside* a **COMPONENT**: a component is a distinct binary (`0x1000d` vs
`0x1`), may **not** export its memory, and crosses component boundaries
**shared-nothing** via the Canonical ABI. A WIT **package** (`namespace:name@version`,
= all `.wit` files in a directory) holds **interfaces** and **worlds**; one component
targets exactly **one world**. Core imports are two-level (`(import "env" "fn")`).
**Neither browsers, Bun, nor Node load components natively in 2026** — Bun's request
(oven-sh/bun#24867) is open; `jco transpile` lowers a component back to a core module
+ JS glue. So the shippable web/Bun artifact is, and must remain, a **single core
`.wasm`** — exactly today's model.

This ADR settles how Silicon names and structures the tier above "file" without
breaking the flat-namespace reality, the frozen LL(1) grammar (ADR 0010/0020), or
ADR 0023's non-goals (`::` is namespacing only; no methods).

## Decision

Adopt a **three physical levels / two semantic tiers** model named in WASM
Component-Model vocabulary, matching its nesting **component ⊃ module ⊃ file** (never
inverted): a **COMPONENT** (the `sgl.toml`-rooted dir) is the distributable/versioned/
composable unit; a **MODULE** (a directory of `.si` files inside it) is the visibility
+ namespacing boundary; a **FILE** (`.si`) is a physical split only with **no**
semantics. The **default build statically merges every module of the component (plus,
by default, its dependency components) into one core `.wasm`** — modules and files
*never* carry Canonical-ABI overhead; a real Component-Model `.wasm` is emitted only
at a genuine runtime boundary via the **(post-v1.0)** `--emit=component` path.

### The three levels

| Silicon tier | What it is on disk | Maps to (WASM / WIT) | What it owns |
|---|---|---|---|
| **Component** | the directory rooted by `sgl.toml` | WIT **package** (`namespace:name@version`) + the single **world** it targets + (post-v1.0, under `--emit=component`) the one CM **component** binary (`0x1000d`) | distribution · versioning · dependency unit · the **only** tier that may ever become a real shared-nothing isolation boundary |
| **Module** | a directory of `.si` files inside a component | internally a slice of the single core `.wasm` module; the **ROOT** module's `@pub`/`@export` surface contributes to the exported WIT **world**; a sub-module becomes a WIT **interface** in the world **only if explicitly re-exposed through root** (otherwise it is purely internal namespacing and never appears in the emitted world) | visibility (`@pub`) · separate type-checking · namespacing (`mod::name`) — **never** a runtime boundary |
| **File** (`.si`) | one source file | nothing at runtime — like one `.wit` file contributing defs to its package; files collapse into the same core module | physical split only; **all** files in a module share one Go-style package-block scope |

Mnemonics: *"the `sgl.toml` folder is what you ship," "a sub-folder is a namespace,"
"a file is just where you typed it."*

### Tier vocabulary + exact WASM mapping

`COMPONENT` ⇒ WIT package + its one world + (post-v1.0) the `--emit=component`
binary; only the component may ever be shared-nothing. `MODULE` ⇒ internally one
slice of the single core module; the ROOT module's public surface becomes the world,
and a re-exposed sub-module becomes a WIT interface (a non-re-exposed sub-module is
internal namespacing only and is **not** part of the component's external contract).
`FILE` ⇒ no runtime unit. This is the canonical bytecodealliance shape (a package
holds many interfaces+worlds; a deployable component picks one world; many `.wit`
files form one package) so the eventual jump is a *wrap-plus-codegen* (see
`--emit=component` caveats below), not a redesign. **Rejected:** mapping a module to
its own nested component/instance (per-module shared-nothing) — it pays lift/lower
overhead per cross-module call, is unsupported on web/Bun in 2026, and contradicts
the locked single-`.wasm` default. Inverting the nesting (file/module as the outer
unit) contradicts both the WASM binary format and the lock.

### Directory-to-module rule (flat)

Every directory inside the component containing ≥1 `.si` file **is** a module, named by
its directory base name. **Module space is FLAT for v1.0**: a module is referenced by a
**single** base-name segment (`strings::trim`, never `src::lib::strings::trim`). Base
names must be unique within a component; a collision is `E-DUP-MOD` printing both
directory paths. On-disk nesting is allowed purely for organization but creates **no**
namespace depth. This is justified two ways: WIT interfaces are addressed flat
(`namespace:pkg/interface`, no nested path); and `ModuleRegistry` is already a flat
`Map<string, ModuleEntry>` keyed by bare names (`watId` `::`→`_` and `path.join('::')`
both assume flat). (Host **FFI** imports are also two-level — `(import "<module>"
"<fn>")` — so a flat module set maps cleanly onto the first import field; but note this
concerns *host imports* only. Intra-component sibling calls are statically merged into
one core module as direct `module__function` calls and never reach the import table, so
the two-level import structure is not the mechanism that carries them.)

This is **net-new discovery work**, not pure reuse. The shipped `loader.ts` discovers
**user** modules *only* from a top-level `<projectDir>/modules/` directory
(`moduleSources.native.ts` `join(projectDir, 'modules')`), and those entries are thin
host-import `@extern` wrappers (`modules/Draw.si` or `modules/Draw/Draw.si`) — a
categorically different thing from `src/` *source* modules, which are **not discovered
at all today**. Making `src/strings/` a callable `strings::` source module is new
behavior layered onto `loader.ts`. Because both populate the **one flat**
`ModuleRegistry`, this ADR specifies their relationship: a `src/` source module and a
`<projectDir>/modules/` host wrapper share one key space; a base-name collision between
them is `E-DUP-MOD` (no silent win — the existing `env > user` rule applies only to the
discovery layers it already governs and does not silently mask a user's own source vs
wrapper clash). Existing `env` modules (`compiler/src/strata/modules/*.si`) and the
`<projectDir>/modules/` wrappers keep their current discovery; what is added is `src/`
source-module discovery. Deep taxonomies are expressed as separate dependency
**components** instead. **Rejected:** Rust-style nestable `mod` trees / Go's deep import
paths for v1.0 — they require rewriting the flat registry key, `watId`, and `::`
resolution, and lengthen every call site; nestable modules behind the same `::` syntax
are a clean, non-breaking v1.x follow-up.

### Source root convention + root module

`sgl.toml` sits at the component root; code lives under `src/` (the scaffolded default).
Files placed **directly** in `src/` form the **ROOT MODULE** (the default namespace),
callable **unqualified** from anywhere in the component. Sub-directories of `src/` are
sibling modules named by their folder. So `src/main.si` + `src/greeting.si` are one root
module; `src/strings/*.si` is module `strings`. Files directly beside `sgl.toml` (no
`src/`) are also a valid root module, but `src/` is the convention. The root module's
WIT-export name is the component name (`[package].name`). This matches Go (root-dir files
= root package) and the **shipped** greeter exactly — those two files simply *become* the
root module and the `@use` line becomes redundant. A beginner drops files in `src/`, calls
between them with bare names, and never learns the module system until they *choose* to
make a folder (folders are an opt-in graduation step, not a day-1 tax). **Rejected:** an
explicit per-directory `@module`/package clause (ceremony contradicting "the directory
listing IS the mental model"); forbidding a root module (breaks hello-world and the
shipped greeter).

### Visibility / export (`@pub` vs `@export`)

**PRIVATE-BY-DEFAULT at the module boundary, FULLY-OPEN within a module's files** (Go
package-block: every file sees every sibling's top-level defs, public or not — files are
never a boundary). **Two orthogonal axes**, both enforced at **elaboration / name
resolution**, never in the parser:

- **(a) Module visibility — `@pub`.** Makes a definition cross-module callable as
  `mod::name`. Confers **no** WASM/host export and **never** reaches the WIT world.
- **(b) Component/host export — the existing `@export`, kept as-is.** "Emit a WASM export
  to the host **and** place this name in the component's WIT world." Narrowed *additively*:
  it already produces the wasm export; it now *also* appears under `--emit=wit`.

A def may be both (`@pub @export`). **The component's WIT world == ONLY the `@export`'d
members of the ROOT module.** `@pub` is purely intra-component cross-module visibility:
a root-module member that is `@pub` but not `@export` is callable as `mod::name` from
other modules **but is not in the world and is not reachable by any consumer**. A
sub-module's `@pub` likewise stays component-internal. (This is the single, consistent
rule used everywhere below, including §Dependencies: only `@export`'d names cross the
component boundary.)

```silicon
# @pub and @export are ORTHOGONAL axes: module-visibility vs WASM/WIT host-export.
# A def can be both — module-public AND part of the component's WIT world.
\\ @pub @export run () -> Int
@fn run := { 0 };
# (Today's transitional standalone `@export run;` statement form still works for host-only export.)
```

**SEQUENCING (a grammar amendment, not merely "unparsed").** The `@pub` marker is a
**signature-line modifier** (`\\ @pub trim (Str) -> Str`) that **extends** ADR-0020
§decision 8. As shipped, decision-8's grammar (`../grammar.ebnf`, the *SignatureLine*
production; ADR-0020 §decision-8 *Modifier* rule) is:

```
SignatureLine = "\\" { Modifier } Namespace [ GenericParams ] TypeExpr ;
Modifier      = "@extern" | "@export" | "@platform" "(" identifier ")" ;
```

`@pub` is **not** in that `Modifier` set — adding it is a genuine **grammar
amendment** to ADR-0020 (and a genuinely new token), not "prerequisite parsing":

```
Modifier      = "@extern" | "@export" | "@platform" "(" identifier ")" | "@pub" ;
```

This stays LL(1): a `\`-led line dispatches to *SignatureLine*, after which `{ Modifier }`
is a pure prefix-token loop where each modifier is distinguished by its leading `@kw`
token, so adding `@pub` introduces no new grammatical *position*. Until that amendment
lands, the only shipped mechanisms are the `@export name;` **statement** form (host
export only; parses today) and the `@extern { \\ ... }` brace form; there is **no**
cross-module `@pub` before that work. Note two distinct `@export` forms: (1) the shipped
transitional `@export name;` **statement** (host export, parses today) — Stage A's
"`@export`-as-WIT-world" rides this; and (2) the designed-but-unparsed `\\ @export …`
**modifier** (decision-8) — lands with Stage B alongside `@pub`.

Two self-documenting markers answer two genuinely different questions ("can sibling modules
call this?" = `@pub`, a pure name-resolution fact with no ABI; "is this a WASM/WIT export?"
= `@export`, a real Canonical-ABI/world fact). Riding the `\\` line keeps "bare = common,
`@` = reserved," stays LL(1) (modifier sits after `\\`, before the `Namespace`). **Rejected:**
Go's `Capitalized = exported` rule (ADR 0023 forbids relitigating identifier casing; making
case load-bearing would surprise existing all-lowercase code); overloading `@export` for
module visibility (export-table + WIT-world bloat, breaking dead-code elimination — the
one-marker footgun); Rust-style graded `pub(crate)`/`pub(in path)` (new grammar surface,
against the freeze). A cross-module-but-not-cross-component tier (`internal/`) is **deferred**
(see Open questions).

### Cross-module reference syntax + imports

**Reuse the existing `::` qualifier verbatim, ZERO new syntax for sibling calls.** Call
module `M`'s `@pub` member `F` as `M::F(args)`, e.g. `strings::trim(x)`. A module's name is
its directory base name. **Sibling modules within the same component are AMBIENT — no import
statement is needed**; `strings::trim` resolves through the same registry-backed lookup that
resolves `web::console_log` today (a new sibling-module precedence layer added to the
**registry path** — it does **not** touch intrinsic resolution, so `WASM::`/`IR::` are
untouched because they never enter the registry, while `web::`/`JSString::`/`console::`/
`wasi_snapshot_preview1::` are untouched because the new layer sits *above* them in the
same registry stack). Root-module members are called unqualified. `::` stays **pure
namespacing** (ADR-0023 honored): `strings::trim(x)` is a `Namespace` primary + `CallSuffix`
where `x` is an ordinary argument, **never** an implicit receiver — never UFCS/method syntax.
LL(1) holds: `Namespace = identifier {('::'|'.') identifier}` is unchanged.

**RESOLUTION PRECEDENCE (specified):** for a **bare** (unqualified) name —
`local binding/param > sibling module > dependency component > env/builtin module`. A
**qualified** `M::f` always resolves `M` as a module/namespace regardless of any same-named
local binding (the `::` form is unambiguously namespacing per ADR-0023 #4), so the precedence
stack applies to bare names only — a local `strings` never shadows `strings::trim`. The
existing registry "env wins over user" preference becomes the **bottom** of this stack, so
**no** existing qualified env/builtin call changes behavior, and intrinsic `WASM::`/`IR::`
resolution is wholly separate and unaffected. The only explicit import line in the language
is the cross-**component** dependency alias (below).

```silicon
# src/strings/trim.si  — module 'strings'.  @pub crosses the module edge; bare = module-private.
# NOTE: `\\ @pub` is the ADR-0020 decision-8 modifier slot AMENDED with @pub —
#       landing that grammar amendment is a prerequisite of ADR-0024 (Stage B).
# `Str` here is the canonical shipped surface string (Slice[u8], ADR-0022).
\\ @pub trim (Str) -> Str
@fn trim s := { scan_ws(s) };

\\ scan_ws (Str) -> Str          # no @pub => visible only inside module 'strings'
@fn scan_ws s := { s };
```

```silicon
# src/strings/case.si  — SAME module 'strings', auto-included, shares the package-block scope.
# Calls scan_ws directly (no @use, no qualifier) because it is the same module.
\\ @pub shout (Str) -> Str
@fn shout s := { str_upper(scan_ws(s)) };
```

```silicon
# src/main.si  — ROOT MODULE.  Sibling module 'strings' is AMBIENT (no import line).
# Only @pub members are reachable across the edge: strings::trim ok, strings::scan_ws is E-PRIV.
@fn main := {
    \\ x Str
    x := strings::trim('  hi  ');   # ambient sibling module, zero import lines
    console::log(x)                 # 'console' is an env/builtin (registry) module, unchanged
};
main();   # trailing top-level statement allowed ONLY in the root module (an ELABORATION rule;
          # see §File auto-inclusion (b) — the parser still accepts top-level Items everywhere)
```

Splitting code into a folder requires **zero** new lines anywhere — make `src/strings/`,
drop a `@pub` fn in, and every other module calls `strings::trim` immediately. It reuses
the shipped registry-path `::` machinery (`nsSep`, `Namespace.path`, `path.join('::')`,
`watId`), so existing `web::`/`JSString::`/`console::` registry calls and `WASM::`/`IR::`
intrinsics are all untouched. **Rejected:** an explicit per-file import statement for
*sibling* modules (net-new grammar; the registry is already whole-compilation-global so
ambient resolution is free); reinterpreting `::` as method dispatch (ADR-0023 non-goal).

### Fate of `@use` (superseded for the common case, scoped down)

- **(a) Intra-module:** `@use` between files in the same module dir is **gone** — files
  auto-compile together. After Stage A, the greeter's `@use 'greeting.si';` still compiles
  but now emits a **deprecation warning** ("redundant: sibling files auto-included");
  `sgl fix` (Stage B) deletes it; later it becomes a hard error.
- **(b) Cross-module:** handled by `mod::name`, never by `@use '../mod/x.si'`.
- **(c) Retained role:** `@use` survives **only** as the bare-name **stdlib** include
  mechanism (`@use 'io';`, `@use 'vec';`) until stdlib pieces become real dependency
  components in v1.x. Its textual-concatenation semantics, dedup (visited `Set` keyed by
  fs path / `std:<rel>`), cycle detection, and the wasm-gc shadow swap (`wasmGcShadowPath`)
  are preserved **exactly**.

```silicon
# stdlib still entered by bare-name @use (RETAINED — the one surviving @use role at v1.0):
@use 'io';
@use 'vec';
# Path @use of a SAME-MODULE sibling is deprecated (auto-included); bare-name stdlib @use is not.
```

`@use`'s concatenation engine **is** the machinery that implements auto-inclusion, so it is
driven from a *new* per-module directory glob for the intra-module case (that glob does not
exist today and is Stage A work) and kept verbatim for stdlib. **Rejected:** deleting `@use`
entirely at v1.0 (breaks stdlib delivery, the wasm-gc shadow swap, and the browser
`inlineStdlibUses` path); forcing stdlib into the dependency model immediately (couples this
ADR to the still-stubbed resolver/lockfile redesign — too much blast radius). A `sgl fix`
codemod ships **with** the visibility change (Stage B) to delete redundant intra-component
path `@use`s and leave bare stdlib `@use`s alone.

### File auto-inclusion + edge cases

All `.si` files in a module directory compile together automatically into one shared module
namespace. Mechanically this **reuses `useResolver`'s concatenation/dedup/strip pipeline**
but drives it from a **new** glob of the module directory (the source-dir glob does not
exist today — `@use` is the only thing that pulls siblings in now — so this is Stage A work,
not pure reuse). Edge cases **settled**:

- **(a) Order** — top-level *definitions* are order-**independent** (the whole-module symbol
  table is built before bodies typecheck, as today); files are presented in **lexical
  filename order** (Go's rule) so order-sensitive emission and global init are deterministic
  and filesystem-independent. `moduleSources.ts`/`moduleSources.native.ts` already apply
  `readdirSync(...).sort()` to *module-directory discovery*; Stage A extends the same `.sort()`
  discipline to the new per-module source-file glob (today nothing orders an entry's `src/`
  source siblings, because they are not discovered at all).
- **(b) Top-level executable statements** — only the **ROOT module** may carry them (e.g.
  the greeter's trailing `main();`). This is an **elaboration-time** diagnostic, not a grammar
  restriction: the parser still accepts top-level Items everywhere (as it does today — the
  greeter's `main();` works because everything concatenates into one namespace), and the
  non-root case is rejected post-parse with `E-MOD-TOPSTMT` ("move executable code into a fn
  or into the root module"); its cross-file execution order would otherwise be ill-defined.
- **(c) Duplicate symbols** — two files in one module defining the same top-level name is a
  hard error `E-DUP-DEF` printing **both** `file:line` locations (no silent last-wins).
- **(d) Global init** — module-level `@global` constants (ADR 0014: immutable, top-level only)
  initialize in **dependency order then declaration order**; an init cycle is an error.
  ADR-0014 specifies the `@global`/`@local` *binding* surface but leaves **init order
  unspecified** — this ordering is **established here by ADR-0024**, extending ADR-0014 (see
  Follow-up: ADR-0014 should be amended to cross-reference it).
- **(e) Mutable top-level bindings** — ADR-0014 also allows `@local` at top level (a *mutable*
  global). Where present, a top-level `@local` follows the **same** dependency-then-declaration
  init order and the **same** init-cycle ban as `@global`; mutable top-level globals are
  permitted across a module's files under the same shared-package-block scope (a later
  borrow-checker ADR may restrict cross-module mutable-global aliasing, but ordering and the
  cycle ban hold today).

Auto-include is the Go directory=package model and maps cleanly to WIT (many `.si` == many
`.wit` files in one package directory). Restricting top-level statements to root removes the
only place file-order could leak into runtime semantics, preserving "file = physical split,
no semantics." **Rejected:** keeping `@use`'s silent first-wins dedup (a footgun); allowing
top-level statements anywhere (ill-defined order); requiring an explicit file-ordering
manifest (ceremony — lexical order is the proven default).

### Entry point

The entry point is a fn named `main` in the **ROOT module**; it may live in any
root-module file, not necessarily `main.si` (like Go's `func main` in `package main`).
`sgl run`/`sgl build` discover `main()` automatically, run module-level initializers in
dependency-then-lexical order, then call `main`. **Back-compat (with a correction to the
shipped reality):** `sgl.toml`'s `entry = 'src/main.si'` is **retained and reinterpreted** —
it names the root module's *directory* (`src/`) and the conventional file holding `main`; it
is no longer "the single file to compile." Today `resolveEntry` returns a **single file path
string** (`cli/src/sigil_cli.ts`) and does **not** produce a dir+file pair or call
`loadModules`; `loadModules(path.dirname(entryAbs))` is invoked **separately** in `compileFile`
and only loads `<projectDir>/modules/` env+user wrappers — it does **not** glob the entry's
sibling `.si` files. So Stage A must **extend** `resolveEntry` (or its caller) to glob the
entry file's directory for sibling `.si` source files and locate `main`; this is **new work**,
not a reinterpretation of existing behavior. If a discovered root `main()` and an explicit
`entry` disagree, explicit `entry` wins with a one-time hint to remove it. A component with
**no** root `main()` is a **library** component (builds + emits its WIT world / `@export`
surface, cannot "run"); `sgl run` on it is `E-NO-MAIN`. For WIT, `main` maps to the WASI CLI
`wasi:cli/run` export (invoked via `wasmtime run` / `jco run`); `jco serve` is a separate
HTTP path (`wasi:http/incoming-handler`) and is **not** the mapping for `main`. **Rejected:**
requiring `main` to literally be in the file named by `entry` (contradicts files-share-one-
scope); a config flag for library-vs-binary (presence-of-`main` is one less declaration);
hard-removing the `entry` key (avoids breaking shipped projects).

### Build output + linking + target relation

**DEFAULT:** statically link/merge **all** modules of the component (root + sub-modules)
**and**, by default, its dependency components into **one core `.wasm`** — the universal
artifact for `--target=wasm` (default) and `--target=wasm-gc` and the web/bun platforms.
Internally this is the existing single-concatenated-program compile (auto-inclusion across
modules feeds one IR/codegen pass, one shared linear memory), so "linking modules" is **free**
and zero-runtime-cost. `--native` (QBE) is unchanged. New emit modes:

- **`--emit=wit`** — **design only; the flag is not implemented at v1.0.** The CLI
  exposes no `--emit` mode beyond `--emit-qbe` (`cli/src/sigil_cli.ts`); today only
  `[package].namespace` is parsed and scaffolded into `sgl.toml` (defaulting to `local`).
  No world/interface is emitted yet. *When built (post-v1.0)* it will emit the
  world/interface *shape* (world from `@export`s; sub-module interfaces only where
  re-exposed through root) with a defined type-mapping for the **scalar/agreed subset** as
  forward-compat metadata alongside the core `.wasm`. It will **not** be a fully
  well-formed package for arbitrary signatures: rich Silicon types (UTF-8 `Str`/`Slice[u8]`
  → `string`/`list`, `@type` records → `record`, `Option[T]` → `option`, sum types →
  `variant`) require a documented Silicon→WIT type-mapping table and the corresponding
  Canonical-ABI contract — a real follow-up. Because generics must be **monomorphized** (ADR
  0001) before they can appear in a fixed WIT world, only concrete monomorphic signatures are
  mappable. Until that table and `[package].namespace` exist, `--emit=wit` emits a world/
  interface skeleton with scalar signatures.
- **`--emit=component`** — **deferred past v1.0**; wraps the core `.wasm` into a CM component
  via `wasm-tools component new` against the generated world. This is a real codegen task,
  **not** a pure wrap: the shipped Silicon core module **exports its linear memory**
  (`std.wat` emits `(memory 1)` + `(export "memory" (memory 0))`; the binary emitter also
  conditionally emits a memory export) and CM **forbids a component exporting its memory**, so
  `--emit=component` must (a) **hide/strip the memory export**, and (b) **generate
  Canonical-ABI lift/lower + `cabi_realloc` glue** (via `wit-bindgen`/`wasm-tools`) for any
  non-scalar type crossing the world boundary. Reserved for the Wasmtime/server tier and real
  boundaries (plugin / dynamic-link / host-composed).

Visibility is resolved at elaboration **before** lowering, so the module/visibility model is
identical across wasm / wasm-gc / native (target-agnostic); allocator + memory-mode remain
whole-program (ADR 0008/0009 untouched). The grounding is emphatic: neither browsers nor Bun
(issue #24867 open) load components in 2026, so the shippable artifact **must** be a single
core `.wasm`. **Rejected:** emitting a real CM component as the default v1.0 artifact
(unrunnable on web/Bun); per-module `.wasm` instances (Canonical-ABI overhead per cross-
module call, unsupported, contradicts the lock); jco-style transpile of a composed component
as the merge strategy (favor source-level static merge — one IR/codegen pass — over runtime
jco/wac). **Accepted cost:** static-merged deps forfeit shared-nothing isolation between
consumer and dependencies — correct for web/Bun, with the post-v1.0 `--emit=component` as the
escape for tiers that want real boundaries.

### Dependencies + dependency namespace

A dependency is another **COMPONENT**, declared in `sgl.toml` `[dependencies]` as
`name = "path:<rel>"` (today's stub — **double-quoted**, per `readSglToml`'s reader; v1.x
adds git/registry per `../lockfile-format.md`). Note `sgl.toml`'s `[dependencies]` is a flat
`name = "<source>"` map (`Record<string,string>`), distinct from `sgl.lock`'s `[[package]]`
array-of-tables with a `source` field (`../lockfile-format.md`) — two different shapes, not
one shared form. Cross-component reference is the **one explicit import** in the language: a
per-**file** alias on a signature line, `\\ @use mathlib as ml;` (or bare `\\ @use mathlib;`
to use the component's own name).

```silicon
# Consuming a DEPENDENCY COMPONENT — the ONE explicit import: a per-file alias signature line.
# sgl.toml -> [dependencies]
#   mathlib = "path:../mathlib"        # double-quoted (the reader only matches "...")
\\ @use mathlib as ml;            # bind dependency component under 'ml' for THIS file
@fn main := {
    \\ n Int
    n := ml::clamp(0, 10, 42);    # call the dependency's root-module @export'd surface -> 10
    console::log(n)
};
```

After binding, the dependency's **root-module `@export`'d world surface** is called as
`ml::clamp(...)`. **Only `@export`'d (world) names cross the boundary** — a dep's `@pub` and
private names are invisible to consumers (the **WIT world IS the encapsulation boundary**,
the same single rule as §Visibility). A dependency **sub-module** is reachable as
`ml::strings::trim` **only** if the dependency re-exposes `strings` through its root world;
otherwise dependency sub-modules are component-private. Dependency components do **not**
pollute the consumer's flat sibling-module space — they are reached only under their alias.
`sgl.lock` pins the resolved set.

**Three-segment resolution (reconciling the flat-registry constraint).** The `ml::strings::trim`
form is a **3-deep** path (`alias → dep component → dep sub-module → fn`) that the flat
`ModuleRegistry` key cannot represent directly (Context item 2: nested `foo::bar::baz` is
impossible without rewriting that storage). For **v1.0, dependency calls are restricted to the
2-segment `ml::clamp` (root-surface-only) form**, which the flat registry *can* carry: the
alias resolves to a name→component binding (a **separate** dependency precedence layer, below
sibling modules) that decodes the first segment structurally and then does a flat lookup of
the dep's root world surface. The 3-segment `ml::sub::fn` (re-exposed dependency sub-modules)
is **deferred to the same v1.x nestable-modules follow-up** that adds multi-segment paths —
so there is no contradiction with the flat-registry argument at v1.0. Dep components statically
merge into the consumer's single `.wasm` by default; this is a **source-level merge before
codegen** (one IR/codegen pass, one shared linear memory). Name-prefixing (dep-name prefix
applied before merge) handles **symbol** capture; the deeper hazards of merging *separately
authored* binaries — two modules each declaring `(memory …)`, each assuming sole ownership of
the heap (`std.wat` hard-codes one `(memory 1)` with the bump-allocator heap base at offset
1024), and data-segment offset collisions — are **avoided** precisely because v1.0 merges at
the **source/IR** level (one memory, one heap, one data-segment layout), not by stitching two
finished `.wasm` binaries. **Binary-level dep merge is out of scope for v1.0.**

**SEQUENCING:** `\\ @use … as …` is a **NEW grammar production**, not part of decision-8.
Decision-8's `Modifier` set (`@extern | @export | @platform(id)`) does not include `@use`; a
*SignatureLine* requires a trailing `TypeExpr` which this line lacks; and `as` is **not a token
anywhere in the lexer/grammar**, with no alias production. So this is an honest **ADR-0020
amendment**: a new `ImportLine` (alias clause) production, e.g.
`ImportLine = "\\" "@use" identifier [ "as" identifier ] ";"`, with `as` added as a new
keyword token. It must be classified LL(1) against the `\`-led *Element* dispatcher
(`../grammar.ebnf`, the *Element*/first-token classifier): a `\`-led line currently dispatches
unconditionally to *SignatureLine*; the amendment makes the first post-`\` token decide
between *SignatureLine* (`{ Modifier } Namespace …`) and *ImportLine* (`@use …`), which is a
single-token lookahead and stays LL(1). This maps exactly to WIT (a dependency is consumed via
its world's exported interfaces; `<alias>::<name>` is the Silicon spelling of
`namespace:package/interface`). **Rejected (and the alternative considered):** dropping the
`as`-alias entirely and binding each dependency under its own component name via the
`[dependencies]` table (so `mathlib::clamp` resolves with zero per-file syntax, matching the
ambient-sibling model) — viable and avoids new grammar, but rejected because cross-component is
exactly where explicit per-file dependency documentation pays off and ambient foreign modules
risk first-segment collisions with local siblings; the alias is the price of that clarity and
is owned here as **new syntax**. Also **rejected:** flattening every dependency symbol into the
consumer's namespace (collision-prone).

### Cycles

**Module import cycles within a component are BANNED** (Go rule): a hard error
`E-MOD-CYCLE` that prints the full cycle path **and** the three blessed fixes inline.
**Component dependency cycles are likewise BANNED** (`E-DEP-CYCLE`, the dependency graph
must be a DAG, enforced at resolve/lock time). Files within one module have **no** cycle
concept (one shared namespace, cross-file references are order-free). The acyclic invariant
is what licenses the deterministic dependency-ordered init established above. The cross-
module graph is computed from observed `M::` references **plus** the explicit dependency
aliases, and the analysis is **conservative** (any `::` mention = an edge) to keep the ban
sound. The existing `useResolver` cycle-detection machinery is repurposed.

```silicon
# ERROR — module import cycle (actionable, unlike Go's bare message):
# E-MOD-CYCLE: module import cycle
#   strings  ->  fmt  ->  strings
#   src/strings/case.si:12   calls fmt::pad
#   src/fmt/pad.si:8         calls strings::trim
#   Fix by one of:
#     1. move the shared piece into a third module both can call
#     2. pass the needed value in as a parameter (capability-style inversion, ADR-0011/0015)
#     3. merge these modules (files in one module may reference each other freely)
```

Acyclic-import is the precondition for deterministic dependency-ordered init and matches
WASM CM's acyclic world composition. The ergonomic make-or-break is the **error**: Go's
bare "import cycle not allowed" is its #1 papercut precisely because it doesn't say how to
fix it. **Rejected:** allowing module cycles (Rust-within-a-crate — forfeits deterministic
init); allowing component dependency cycles (same, and breaks WIT composition); trusting
the user / zero edges (unsound — the conservative any-`::`-is-an-edge analysis may reject
some technically-acyclic-at-runtime programs, accepted as the cost of a sound ban, with the
merge-files escape always available).

### Capabilities / object-capabilities interplay (ADR 0015)

**Orthogonal, with one reinforcing overlap.** The module boundary is purely **lexical**
namespacing + visibility — a compile-time name-resolution fact that confers **no
authority**. Object-capabilities (ADR 0015) stay value-level, unforgeable, explicitly
threaded: importing/seeing `fs::open` does **not** confer filesystem authority; you must be
**handed** a capability *value* (the no-ambient-authority invariant is intact).

```silicon
# Capability mint-site is module-private simply by NOT being @pub — unforgeable from outside
# the issuer module (ADR-0013 P5 leg 2), with on::check as the primary mint-site guard.
@type FsCap := { root Str };         # a real TypeDef (@type); constructor module-private by default (no @pub)
\\ @pub open (FsCap, Str) -> Int     # @pub: other modules may CALL open, but only with a cap VALUE
@fn open cap, path := { fs_open_raw(cap.root, path) };  # authority is the value, not the import
```

**Reinforcing overlap:** a capability's mint-site constructor is simply left non-`@pub`
(module-private by default), so by the ordinary visibility rule it cannot be constructed
outside its issuer module — delivering the **"module-private constructor"** that ADR-0013 P5
leg 2 named as the single likely new privacy primitive, now **for free** (it's just "not
marked `@pub`"), as structural defense-in-depth. `on::check` (ADR 0013 P2) additionally
enforces the mint-site restriction as the **primary** checker rule, consuming the existing
`symbol_module`/`is_local` reflection surface, which now corresponds to the real module
(directory) identity. Cross-module/cross-component authority flow stays explicit
(capabilities passed as parameters; never leaked via module scope or via the WIT world
unless explicitly `@export`'d as a typed capability — which, with the post-v1.0
`--emit=component`, lifts/lowers as a WIT resource/handle). The **HM-lite budget holds**
(ADR 0011/0012/0015 point 8): visibility introduces no row variables / no effect
polymorphism — required-capability sets stay concrete per monomorphized instance even across
boundaries, written to the module/world at the seam, not inferred per call site. **Rejected:**
letting the module boundary *gate* authority (would create ambient authority, violating
ADR-0015's core invariant); a separate access modifier for capability constructors (redundant
— default-private visibility supplies the structural leg); relying on visibility alone for
unforgeability (the `on::check` mint-site rule remains primary, so a mistaken `@pub` on a
factory is caught by the checker).

### Comptime / strata interplay (ADR 0003/0013)

Modules and strata stay **separate, non-entangled** systems. Strata
(`@stratum_keyword`/`@stratum_operator` in `compiler/src/strata/*.si`) remain **globally
registered** in the elaborator registry — custom operators and keywords are component-wide
(and language-wide for built-ins), **not** module-scoped, because syntax must be uniform.
Module visibility (`@pub`) applies to ordinary value/function/type defs, **never** to strata
definitions. Comptime execution is unaffected; `on::check` fires per module (that module's
bodies + imported modules' *signatures*, per ADR 0013), consistent with per-module compilation.
Comptime-clean stdlib collections (`vec.si`, `hashmap.si`) stay `@use`-able by handlers
(ADR 0013 P3b preserved) and are `@pub`/`@export` by construction, so no handler ever faces
a "private `Vec` but no public `Vec`" situation. A non-`@pub` member is still fully usable at
comptime **within** its own module. Visibility is enforced at elaboration/name-resolution (a
symbol-not-in-scope / is-private error), **not** in codegen — keeping strata data-driven and
not module-aware; the two registries (elaborator vs `ModuleRegistry`) stay separate exactly
as today. **Rejected:** module-scoped strata (would fragment the grammar per directory,
contradict the data-driven model, make syntax non-uniform); codegen-rewrite visibility
enforcement (would make strata module-aware); private stdlib collections (would break
comptime handlers).

## Options considered

### Option A — Flat namespace as namespacing + visibility (the `::`/`@pub` axis) *(adopted angle 1)*
Reuse `::` for cross-module calls; private-by-default at the module edge via `@pub`; ambient
siblings. **Pros:** zero new grammar for sibling calls, reuses the shipped registry-path
`::`/`watId` machinery; splitting into a folder costs zero lines; LL(1) preserved; honors
ADR-0023 (`::` is namespacing only). **Cons:** `@pub` adds a new modifier token (an ADR-0020
amendment) and `\\ @use … as …` is a net-new `ImportLine` production; a reader can't see a
file's in-component sibling dependencies at the top (accepted for code you own); the default-
private edge is a breaking change for projects that split into named sub-modules (covered by
`sgl fix` + `E-PRIV`).

### Option B — WASM Component-Model tier mapping (the build/linking + WIT axis) *(adopted angle 2)*
Name the tiers in CM vocabulary (component ⊃ module ⊃ file), static-merge into one core
`.wasm` by default, emit WIT-shape as forward-compat insurance, reserve real components for
post-v1.0 opt-in boundaries. **Pros:** the only shippable web/Bun artifact in 2026 (no native
component loading); modules cost zero runtime; the eventual component step aligns with
`wasm-tools`/`jco`. **Cons:** the component step is a real codegen task (memory-export hiding +
Canonical-ABI glue), not a pure wrap; static-merged deps forfeit shared-nothing isolation
(correct for web/Bun; post-v1.0 `--emit=component` is the escape); `--emit=wit` emits only a
mapped-subset shape that nothing consumes yet and is gated on `[package].namespace`.

### Option C — Go's directory=package + acyclic-init + capability orthogonality (the semantics axis) *(adopted angle 3)*
Files in a directory share one scope; banned import cycles license deterministic dependency-
ordered init (established by this ADR, extending ADR-0014); the module boundary carries zero
authority (capabilities stay value-level). **Pros:** proven, low-ceremony; matches the shipped
greeter; deterministic init; the visibility primitive devs already learn (`@pub`) doubles as
the unforgeability mechanism ADR-0013 needed. **Cons:** Go's cyclic-import friction (mitigated
by an actionable `E-MOD-CYCLE` listing the three escapes); the conservative cycle analysis may
reject some runtime-acyclic programs (merge-files escape always available); requires new
source-dir glob discovery (not present today).

### Option D — Do nothing (keep the flat global namespace)
Keep `@use` textual concatenation and one global namespace, deferring scoping indefinitely
(`../use-includes.md` "No namespacing yet"). **Pros:** zero work; nothing breaks. **Cons:**
no encapsulation, no collision prevention between user functions and module names, no path to
WIT/components, no library story; "package soup" as projects grow. **Rejected** — it forfeits
the entire reason this ADR exists.

> The decision **combines A + B + C**: Option A's `::`/`@pub` syntax, Option B's CM tier
> mapping and single-`.wasm` default, and Option C's directory=package semantics + acyclic
> init + capability orthogonality. They are the three faces of one model, not competing
> alternatives.

## Consequences

**Positive:**

- Splitting code into a folder costs **zero new lines** (ambient siblings); reuses the shipped
  registry-path `::` / `ModuleRegistry` / `watId` machinery, so existing registry calls
  (`web::`/`JSString::`/`console::`/`wasi_snapshot_preview1::`) and intrinsics
  (`WASM::`/`IR::`) are untouched.
- The shipped greeter migrates with no behavior change: after Stage A it still compiles, with
  `@use 'greeting.si';` now emitting a deprecation warning; `sgl fix` (Stage B) deletes that one
  line. Hello-world ergonomics are preserved (drop files in `src/`, bare calls, learn modules
  only when you make a folder).
- Modules and files carry **zero runtime cost** (static-merged into one core `.wasm`) — the
  only artifact web/Bun can load in 2026 — while WIT-shape emission is forward-compat insurance
  for the mapped type subset.
- The visibility primitive devs already learn (`@pub` or not) **is** the capability
  unforgeability mechanism ADR-0013 needed (module-private constructor for free), so the
  security property comes with no separate access modifier.
- Deterministic dependency-ordered init (established here, licensed by the cycle ban) gives
  ADR 0014 globals a concrete, reproducible trigger point; `E-MOD-CYCLE` turns Go's #1 papercut
  into a guided fix.
- Honors every related ADR: LL(1) preserved across the grammar amendment (a `@pub` modifier
  token + an `ImportLine`/`as` token, each single-token-lookahead), `::`-is-namespacing-only
  (ADR 0023), no ambient authority (ADR 0015), whole-program memory mode (ADR 0008/0009),
  HM-lite budget (no rows/effects).

**Negative:**

- **Default-private at the module edge is a breaking change** against the shipped flat-global
  model — any cross-file reference *not* in the same module dir needs `mod::` qualification or
  `@pub` (benign for shipped examples, which keep collaborators in one root module).
- Requires **grammar amendments** to ADR-0020 (a new `@pub` modifier token; a new
  `ImportLine`/`as` alias production) plus **new discovery/glob work** (`src/`-subdir source
  modules, the per-module source-file glob, entry-dir globbing in `resolveEntry`) — none of
  which exist today; staged delivery is required and the work is **not** "nearly free."
- A file does not advertise its in-component sibling dependencies at the top (ambient siblings);
  cross-component deps *do* (the one explicit alias) — an intentional asymmetry.
- Conservative cycle analysis (any `::` = an edge) may reject technically-acyclic-at-runtime
  programs; static-merged deps forfeit shared-nothing isolation between consumer and deps.
- The CM `--emit=component` path is a real codegen task (memory-export hiding + Canonical-ABI
  lift/lower + `cabi_realloc` glue), deferred past v1.0 — not a mechanical wrap.
- Flat module space (incl. 2-segment-only dependency calls at v1.0) defers deep taxonomies and
  re-exposed dep sub-modules to separate dependency components / a v1.x nestable follow-up.

**Follow-up work:**

- Amend ADR-0020 §decision-8: add `@pub` to the `Modifier` rule and add a new `ImportLine`
  (`\\ @use … [as …];`) production with an `as` token (the hard prerequisite), then land
  `@pub` default-private visibility + `\\ @use … as …` dependency aliases (**Stage B**).
- Amend ADR-0014 to cross-reference the dependency-then-declaration init order (and the cycle
  ban) established here for `@global`/top-level `@local`.
- Add the **new** source-dir glob discovery: `src/`-subdir source modules in `loader.ts`, the
  per-module source-file glob driving `useResolver`'s concat pipeline, and entry-dir globbing
  in `resolveEntry`/its caller.
- Define the **Silicon→WIT type-mapping table** (`Str`/`Slice[u8]`→`string`/`list`,
  `@type`→`record`, `Option[T]`→`option`, sum→`variant`; monomorphic only, ADR 0001) required
  before `--emit=wit` is well-formed beyond scalars.
- Ship `sgl fix` **with** the visibility change (Stage B): delete redundant intra-component path
  `@use`s; leave bare stdlib `@use`s; emit warnings pointing at the exact line to delete.
- Add `[package].namespace` to `sgl.toml` (default `local:` until a registry/org story exists)
  so `--emit=wit` output is well-formed (`namespace:name@version`).
- Decide the `internal/` subtree tier (Go 1.4), nestable modules behind `::` (v1.x, which also
  unlocks 3-segment `ml::sub::fn` dependency calls), and the re-export mechanism for a
  dependency's sub-module — see Open questions.
- Wire the post-v1.0 `--emit=component` (`wasm-tools component new` + memory-export hiding +
  `wit-bindgen` Canonical-ABI glue) when the Wasmtime/server tier matures.

### Open questions

- **`internal/` subtree visibility tier** (cross-module-but-not-cross-component): kept to two
  clean axes (`@pub`/`@export`) at v1.0. Path convention (`src/internal/`) vs marker
  refinement (`@pub(component)`, risks new grammar surface)?
- **WIT package namespace source:** `[package].namespace`, registry/org derivation, or default
  `local:`? Required before `--emit=wit` is well-formed.
- **Silicon→WIT type mapping:** the exact mapping for `Str`/`Slice[u8]`, `@type` records,
  `Option[T]`, and sum types — and the Canonical-ABI contract each implies — before `--emit=wit`
  carries non-scalar signatures.
- **`@export` rename** to `@host_export` (or similar) to make the `@pub`-vs-`@export` axis
  explicit at the def site? Keeping `@export` avoids churning shipped examples (`demo.si`,
  `web_letters.si`); user testing may show persistent confusion.
- **Re-exposing a dependency's sub-module** from a consumer's root (so `ml::strings::trim` is
  reachable, the deferred 3-segment form): explicit re-export syntax vs the dependency's world
  declaration deciding it.
- **Cycle-analysis precision:** does v1.x add per-reachable-call edge analysis, or is the
  merge-files escape sufficient for false-positive cycles (e.g. a sibling referenced only
  under a comptime/conditional branch)?
- **`sgl run` auto-invoke** of a discovered root `main()` vs requiring the explicit trailing
  `main();` (as the greeter has today)?
- **wasm-gc shadow swap** (`wasmGcShadowPath`) currently hangs off `@use` stdlib resolution —
  how is per-target stdlib swapping expressed once stdlib pieces become dependency components?
- **Flat-namespace back-compat mode** for projects relying on cross-file unqualified
  references that will land in different modules, or is `sgl fix` + `E-PRIV` the sole path?

## Implementation status

**Implemented (2026-06-08).** The model ships as a **source-level static-merge front-end**
(`compiler/src/modules/component.ts`, `assembleComponent`) invoked by the CLI before the
unchanged `compile()` pipeline — the prescribed "name-prefixing before the source/IR-level
merge." A component is assembled by prefixing every sub-module `M`'s top-level defs and their
references to plain `M__name` identifiers (scope-aware, via AST-driven text-edits, so a
local/param/`@match`/`@loop` binding that shadows a def name is left alone), and rewriting every
cross-module `M::f` to `M__f`. The result is one flat program the shipped compiler accepts
verbatim (`watId` leaves `M__name` untouched — it never routes through the import-only
`lowerModuleCall`), so modules/files cost **zero** runtime, exactly as designed.

What landed, by stage:

- **Stage A** — directory = module discovery (root files = ROOT module; every `.si`-bearing
  sub-directory = a flat sibling module; `modules/`, `node_modules/`, dot-dirs excluded);
  sibling-file auto-inclusion in lexical order; `mod::name` cross-module calls into the merged
  source; cycle ban (`E-MOD-CYCLE`, actionable); entry-from-root + `main` discovery in any
  root-module file (`E-NO-MAIN` for libraries); `E-DUP-MOD` / `E-DUP-DEF` / `E-MOD-TOPSTMT`;
  the `@export` **statement** as the host/WIT-world surface; `W-USE-REDUNDANT` deprecation for
  intra-component path `@use` with bare-name stdlib `@use` retained verbatim.
- **Stage B** — the ADR-0020 §decision-8 grammar amendment (`@pub` + `@export` added to the
  signature-line `Modifier` set; the `\\ @export` modifier synthesizes the shipped `@export`
  statement); `@pub` default-private visibility (`E-PRIV`); cross-component dependency aliases
  (`\\ @use name [as alias];` as a pre-parse directive, consistent with `@use`), with
  `path:` dependencies statically merged via the same re-prefix-as-module mechanism, restricted
  to the 2-segment `alias::fn` root-`@export` surface (`E-DEP-UNRESOLVED` / `E-DEP-CYCLE`); and
  the `sgl fix` codemod (deletes redundant intra-component path `@use`s, keeps bare stdlib ones).

**Deferred past v1.0** exactly as argued above: `--emit=component` (CM binary, memory-export
hiding, Canonical-ABI glue); **`--emit=wit` in full** — no `--emit=wit` flag exists yet (the
CLI ships only `--emit-qbe`); only `[package].namespace` is parsed and scaffolded (defaulting
to `local`), so the type-mapping table *and* the world/interface emitter are both the
post-v1.0 follow-up; 3-segment `ml::sub::fn` re-exposed dependency sub-modules; binary-level dependency
merge; the `internal/` tier; and nestable modules. The `\\ @use … as …` line is implemented as
a pre-parse directive rather than a parser `ImportLine` node (consistent with how `@use` itself
is "not a grammar construct"), so the LL(1) classifier is untouched.

Tests: `compiler/src/modules/component.test.ts` (assembler unit — prefixing, scope-aware
shadowing, visibility, every module-edge diagnostic, dependencies),
`compiler/src/grammar/module-visibility.test.ts` (the modifier grammar), and
`cli/src/sigil_cli_modules.test.ts` (CLI end-to-end: multi-module build, `E-PRIV`,
`E-MOD-TOPSTMT`, `E-NO-MAIN`, dependency build, `sgl fix`, standalone-file isolation).

## Implementation pointer

Staged delivery (both stages landed): **(Stage A)** source-dir glob auto-inclusion +
flat directory=module discovery + `::` cross-module calls + cycle ban + entry-from-root-module +
`@export`-**statement**-as-WIT-world — reuses the shipped `useResolver` concat pipeline (for
stdlib) and the existing `@export` *statement* form, plus the new source-dir discovery/glob in
`assembleComponent`; **(Stage B)** the ADR-0020 modifier amendment (`@pub`/`@export` on the
signature line) + `@pub` default-private visibility + dependency aliases + `sgl fix`.

An implementation would touch (from the grounding):

- `compiler/src/modules/useResolver.ts` — drive auto-inclusion from a **new** per-module
  directory glob (reuse concatenation/dedup/strip/cycle-detection/`wasmGcShadowPath`);
  deprecation warning for intra-module path `@use`; keep bare stdlib `@use` verbatim.
- `compiler/src/modules/{loader.ts,moduleSources.ts,moduleSources.native.ts}` — **add**
  `src/`-subdir source-module discovery (directory base name; `E-DUP-MOD`, including collisions
  with existing `<projectDir>/modules/` host wrappers in the shared flat key space); register
  user sibling modules + dependency components as registry entries; extend the existing
  `readdirSync(...).sort()` discipline to the new per-module source-file glob (today's `.sort()`
  orders module-directory discovery, not entry source-file siblings).
- `compiler/src/modules/registry.ts` — keep `ModuleRegistry` **flat**; add the resolution
  precedence stack for **bare** names (local > sibling > dependency > env/builtin, env/builtin at
  the bottom); qualified `M::f` resolves `M` as a module regardless of locals.
- `compiler/src/parser/handwritten/{lexer.ts,parser.ts}` — ADR-0020 amendments: add the `@pub`
  modifier token to the `Modifier` set, and a new `ImportLine` production (`\\ @use … [as …];`)
  with an `as` keyword token, dispatched from the `\`-led classifier by one-token lookahead
  (`Namespace` itself unchanged).
- `compiler/src/types/typechecker.ts` (`Ctx.symbols`, `typeOfNamespace`) — visibility
  enforcement at name resolution (`E-PRIV`); `E-DUP-DEF` (both `file:line`); `E-MOD-TOPSTMT`
  (post-parse, root-only); module-scoped symbol tables over the still-flat join key.
- `compiler/src/ir/lower.ts` (`callName`, module-call lowering → `module__function`, `watId`) —
  unchanged `::`→`_`; `WASM::`/`IR::` intrinsic resolution stays separate from the registry; apply
  **dep-name prefixing before the source/IR-level merge** to prevent cross-component WAT symbol
  capture (binary-level merge out of scope for v1.0).
- `compiler/src/elaborator/{registry.ts,elaborator.ts}` — strata stay globally registered,
  unaffected; `on::check` consumes `symbol_module`/`is_local` against real module identity.
- `cli/src/sigil_cli.ts` (`readSglToml`, `resolveEntry`) — **extend** `resolveEntry` (or its
  caller) to glob the entry file's directory for sibling source files and locate `main` (it returns
  a single file path today; `E-NO-MAIN`); add `[package].namespace`; keep `[dependencies]` as the
  double-quoted `name = "path:<rel>"` map (distinct from `sgl.lock`'s `[[package]]`/`source`);
  `sgl.lock` pins the set; add `--emit=wit` (mapped-subset, namespace-gated) and the post-v1.0
  `--emit=component` flag.
- New: `sgl fix` codemod (ships with Stage B); `wasm-tools component new` + `wit-bindgen`
  Canonical-ABI/memory-export-hiding integration for the deferred `--emit=component`.
- Migrate `examples/greeter/src/{main.si,greeting.si}` (delete the redundant `@use` via `sgl fix`)
  and align `../use-includes.md`, `../lockfile-format.md`, `../grammar.ebnf`, ADR-0014, ADR-0020,
  and the docs index.

```
myapp/sgl.toml             -> the COMPONENT root (= WIT package + world)
myapp/src/main.si          -> ROOT MODULE (named 'myapp'); holds `main`
myapp/src/util.si          -> still ROOT MODULE (sibling, auto-included)
myapp/src/strings/trim.si  -> MODULE 'strings'
myapp/src/strings/case.si  -> MODULE 'strings' (sibling, auto-included, shares scope)
```
