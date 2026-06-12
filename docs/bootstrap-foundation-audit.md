# Pre-bootstrap foundation audit — CaaS API + Strata surface

**Status:** audit · **Date:** 2026-06-12 · **Scope:** everything the Phase-2
port (see [`qbe-self-host-plan.md`](qbe-self-host-plan.md),
[`bootstrap-blockers-and-order.md`](bootstrap-blockers-and-order.md)) must
reproduce, across the CaaS surface (`compiler/src/caas/`), the `Compiler::*`
intrinsic API (`compiler/src/compiler-api/`, `comptime/`), and the Strata
system (`strata/*.si`, `elaborator/`). Verified against code on `v1-roadmap`.

Legend: 🔴 **missing / decision required before bootstrap** · 🟡 **highly
desirable before bootstrap** · ✅ solid as-is.

---

## Executive summary

The foundation is in better shape than the planning docs say — with one
material exception, which is this audit's headline:

> 🔴 **The AST-walking interpreter the self-host plan tells us to port no
> longer exists.** `qbe-self-host-plan.md` (2026-06-01, "The comptime
> unlock") rests on porting "the AST-walking interpreter fallback." The
> D-E-3 dissolution work landed *after* that doc: named handlers now
> **throw** if no compiled WASM instance exists
> (`strataLoader.ts` ~`:465` — "D-E-3 PR 2: no fallback"), and inline
> blocks are auto-extracted, translated by `legacyBlockTranslator`, and
> compiled — "No interpreter call at fire time" (`strataLoader.ts`
> ~`:478`). `compileHandlerBlock` survives only in comments. Every stratum
> handler today executes exclusively as compiled WASM
> (`comptime/engine.ts`). **The plan's comptime strategy must be re-decided
> before Track B starts** — see R1 below.

Everything else is strong: the Strata surface is genuinely data-driven
(~1,160 LOC of `.si` defines all 74 operators, 19 keywords, 2 annotations),
the `Compiler::*` surface is finite and enumerable (~85 intrinsics, ~88%
already expressible through the typed `&compiler::*` import boundary), and
CaaS is at declared 1.0 stability with ~3,300 LOC of tests and a
byte-identical incremental pipeline. The gaps are a handful of decisions and
documentation debts, listed at the end as an ordered punch list.

---

## 1. What the bootstrap must reproduce — the inventory

High-level: the port rewrites **~18.5k LOC of TS** into Silicon. By subsystem,
with the key low-level features each must preserve:

| Subsystem | TS LOC | Key low-level features the port must preserve | Status |
|---|---:|---|---|
| **Lexer + parser** | 1,096 | LL(1), 1-token lookahead; ASI (newline/eof as `;`, `parser.ts:183,255,262`); raw strings (no escapes — intentional); digit separators; `$Name` variant declarators; `\\ name Type` signature lines; **relative-position green tree** (`elemBase` + `relSpan` + `PositionTable`) — see §4 | ✅ port |
| **AST + binder** | ~400 | `ast/binder.ts` (S1): every local occurrence → concrete binding; `paramIndex`; `containingSymbol`; runs post-elaboration. Non-optional — rename/find-refs scope-correctness | ✅ port |
| **Strata loader + registry** | 1,435 | T0→T2→T1 tier order; cycle detection (`detectT0Cycles`); typed-operator lookup with fallback (`+:Float` → `+`); `stratumSignature` staleness hash; def-kind registry; `namedHandlers`/`compiledHandlers` split | ✅ port |
| **Elaborator + desugars** | ~800 | `loopDesugar.ts` (255 LOC — pre-typecheck, emits *tagged* `vec_len`/`vec_get_i32` for M1 retarget); `closureDesugar.ts` (~200 LOC); module-finalize ordering | ✅ port |
| **Comptime execution** | ~2,000 | 🔴 **strategy undecided** — see R1. Today: compile-to-WASM only (`engine.ts`), handle-table ABI (`handles.ts`, `IR_HANDLE_ABI.md`), iterate-until-stable pre-compile pass (handlers depend on handlers) | 🔴 decide |
| **Typechecker + unify** | 2,687 | HM-lite (declared-polymorphism only, no let-generalization); 14 hardcoded primitive kinds (`types.ts:138–149`); per-call-site instantiation (`typechecker.ts:2172–2224`); `Vec[T]`≡`Int` on linear-mem (`:2157`); `Array[T]`≡`Int` (`:2162`); M1 tagged-call retarget; E0016 async coloring; E0017 `@cap_derive` confinement (`:1808`); fresh-var counter is **order-sensitive** (matters for E2, §4) | ✅ port |
| **IR + WASM emitter** | 3,547 + 1,800 | string layout `[u32_LE_len][utf8]` (`lower.ts:160–185`); `@extern` expansion incl. externref/JSString stamps (`:1231–1310`); sum `[tag, fields…]` pad-to-max; wasm-gc type interning; deterministic output (the oracle's byte-diff depends on it) | ✅ port |
| **QBE emitter** | 1,345 | must first **triple** to WASM parity (Track A — the long pole; see blockers doc) | 🔴 Track A first |
| **Module assembler** | 700+ | `modules/component.ts` source-merge (`M::f` → `M__f`), `@pub` visibility, three-tier component/module/file | ✅ port |
| **CaaS core** | 7,291 | the subset in §4 — SemanticModel assembly, Workspace cross-doc invalidation, green-tree contract | ✅ port (subset) |
| **Conformance corpus** | ~8,500 (tests) | 🟡 TS-shaped today — see R3 | 🟡 extract |

---

## 2. Strata surface audit

### What is data (ships as-is — zero port cost)

17 core `.si` files + 23 host-API module files, **~1,162 LOC**, loaded by
tier (T0 builtin → T2 `--strata` CLI → T1 in-source). Registrations: **74
operators** (31 primary + 43 typed overloads keyed `+:Float` style), **19
keywords** (12 def-kinds + 7 expression), **2 annotations**. The strata
files themselves need *no changes* for bootstrap — the port reads the same
bundle.

Load-bearing core (every program touches): `operators.si` (441 LOC),
`defkinds.si` (123), `control.si`, `if.si`, `loop.si`, `match.si`,
`generics.si` (54 — the M0 monomorph stratum, sole consumer of the
`state()` memoization surface). Niche: `cap.si`, `arena.si`, `funcref.si`,
`metadata.si`.

### Phase hooks (confirmed live set)

`StratumPhase = 'decl' | 'callSite' | 'annotation' | 'lower' |
'moduleFinalize' | 'comptime'` (`registry.ts:63`). Actual usage: `lower`
~60+, `decl`/`callSite` only by generics, `annotation`/`moduleFinalize`
reserved-but-unused. **Confirmed absent:** `on::optimize`, `on::check`,
`on::parse` — fine for bootstrap; post-fixpoint work (see blockers doc).

### 🔴 What is *not* data — the TS-hardcoded list

Each item below is language behavior **not** expressed as a stratum; the
port must hand-write it in Silicon. This is the definitive list (nothing
else hides outside it):

1. **Primitive types** — 14 kinds baked into `types/types.ts:138–149`.
2. **The entire HM-lite engine** — `typechecker.ts` (2,267) + `unify.ts`
   (420). Strata register syntax, not typing rules.
3. **`@match` expansion** — `match.si` is 11 lines delegating to
   `expandMatchChain` (`compiler-api/index.ts:1022–1070`): alternation
   normalization, tag dispatch, destructuring. Port as a library fn.
4. **`@loop` iterable desugar** + M1 typecheck retarget (pre-typecheck pass
   + tagged-call rewrite — two coordinated halves in different phases).
5. **Closure desugar** (`closureDesugar.ts`) — env capture synthesis.
6. **Sum/record/struct def expanders** (`defExpanders.ts`) — constructor
   synthesis, layout registration; `.si` side only delegates.
7. **`@extern` expansion** — platform-conditional externref/JSString stamps.
8. **Module source-merge** (`component.ts`) — pre-parse transformation.
9. **String literal layout + allocation** (codegen-embedded).
10. **ASI** (parser-level).
11. **Capability confinement (K0)** — typechecker call-site rule, not a
    stratum (despite `cap.si` existing for lowering).
12. **`Vec`/`Array` ≡ `Int` representation rules** (target-conditional).

> 🟡 **Desirable:** record this list in `strata.md` as the honest
> "hardcoded perimeter" — today the doc implies more is data than is.

### Loader / user-strata reality check

User strata work today via `--strata file.si` (T2) and in-source `@stratum`
(T1) — the bundle is *not* closed, which is good news for "strata as mods."
But there is no manifest/`sgl.toml` surface for them and no comptime module
loading. ✅ acceptable for bootstrap; post-fixpoint feature.

---

## 3. `Compiler::*` API audit

### Size and shape

**~85 intrinsics** in `compiler-api/index.ts` (~1,200 LOC), in 11 groups:
ctx access (16: locals/globals/varNames/loopStack/funcref/structTypes/
wasmGcTypes/target), IR builders (21 `ir.make*`), lowering recursion (9
`lowerExpr`/`lowerBlock`/`lowerFunctionBody`/…), type resolution (5),
types-as-data (`type.*` — 11, generics machinery), AST synthesis (`ast.*` —
11, template capture/clone/substitute/patch), module mutation (2), diag (2),
state buckets (4 ops × 2 scopes), utilities (~10), and the 8 heavyweight
**expanders** (`expandMatchChain`, `expandExtern`, `expandSumType`,
`expandTypeRecord`, `expandStruct`, `expandWithArena`,
`expandMoveToParentArena`, `expandCallIndirect`) — each a TS algorithm the
port rewrites (§2 list).

**This surface is the Phase-2.4 port contract.** Its true boundary is
`comptime/imports.ts` — the typed `&compiler::*` import table (~75
intrinsics, i32-handle ABI per `IR_HANDLE_ABI.md`), which covers ~88% of the
API. Interpreter-era-only stragglers (`resolveIntrinsic`, `unwrapNode`,
`lowerBlock`, `choose` — ~0 uses in `.si`) are **trim candidates: delete
before the port rather than porting dead weight.**

### 🔴 Execution paths — the headline finding, restated precisely

- `tryCompileHandler` (`engine.ts:271`): *"After D-E-1 the named-handler
  wrapper requires a compiled instance — **no interpreter fallback** — so
  null returns surface as build-time errors."*
- Named-handler wrapper (`strataLoader.ts`): compiled instance or
  **throw** ("D-E-3 PR 2: no fallback").
- Inline blocks: `makeAutoExtractedHandler` → synthetic `@fn` →
  compiled. "No interpreter call at fire time."
- Stale comments at `engine.ts:98,137` still mention falling back —
  misleading; the fallback is an *error path*, not an interpreter.

Consequence for bootstrap → **R1** below.

### State / memoization surface

`registry.stratumState: Map<string, Map<string, any>>` (`registry.ts:144`);
`state('stratum'|'instance')` + `has/get/set/each`; sole consumer is
`generics.si` (`mono::<fn>$<suffix>` keys). Small, port as-is. ✅

### 🟡 Doc drift — `compiler-api.md` documents only the dead era

`docs/compiler-api.md` covers the Phase-A interpreter surface (§3.1–3.6,
accurate as far as it goes) but **omits everything Strata 2.0**: `type::*`,
`ast::*`, `module::*`, `diag::*`, `state()`, `register::*`, `on::*` phases,
`generic_template`, and all 8 expanders. The port team's contract is
currently split across `compiler-api.md` (stale), `strata.md` §5, and
`imports.ts` source. **Write the authoritative `Compiler::*` spec (or
regenerate `compiler-api.md` from `imports.ts`) before porting begins** —
this is the cheapest highest-leverage pre-bootstrap doc task.

---

## 4. CaaS API audit

### Verdict

Declared 1.0-stable (`caas/index.ts:3–8`), 7,291 LOC + 3,300 LOC tests
(17 files, 170+ Workspace cases). Roslyn-parity Tiers 1–4 complete
(2c containingSymbol closed 2026-06-12 via S1). **No
documented-but-missing APIs.** ✅ The audit's job here is triage: what the
Silicon port must reproduce vs what can be rebuilt later.

### Must port (encodes compiler semantics — LSP/playground die without it)

| Piece | Why |
|---|---|
| `SemanticModel` assembly (`typeOf`/`symbolAt`/reference maps) | per-node type stamping happens *during* typecheck; not reconstructible after |
| Binder S1 (`localBindingSpans`, `isLocalOccurrence`, `unshadowedReferenceSpansForName`, `containingSymbol`) | scope-correct rename/refs; not optional |
| Workspace cross-doc machinery (`externalSymbols` threading, signature-driven `refreshDocument`/`refreshDependents` to fixpoint) | cross-file correctness is a *typechecker input*, not a UI feature |
| Projects (3a) dependency-scoped visibility | symbol-resolution semantics |
| **Green-tree contract**: `elemBase` + `relSpan` + `GreenIndex` + `ElementReuse` | see warning below |

> 🟡 **The one expensive-to-retrofit decision: the ported parser must emit
> the relative-position green tree from day one**, even if incremental
> compilation itself is deferred to post-fixpoint. E1a (reparse) → E1b
> (elaborate) → E2 (typecheck prefix-reuse with fresh-var counter replay,
> `incrementalTypecheck.ts:625`; gates: `preRegSig`/`externalSig`/`target`)
> are deeply coupled through `ElementReuse` alignment and `elemBase`
> shifting. The *algorithms* can be ported later — full-recompile LSP is a
> correct degraded mode — but if the stage-1 parser bakes in absolute
> positions, retrofitting `relSpan` touches every AST consumer. Cheap now,
> brutal later.

### Can rebuild later / defer (presentation, not semantics)

Hover/completion/signature-help shaping, `formatDocument`/`formatRange`
(lossy by design — no trivia layer), `WorkspaceEdit`/`applyEdits`,
`SyntaxWalker`/`SyntaxRewriter`, code-action registry (CaaS-11),
levenshtein hints, cancellation plumbing. All thin adapters over
SemanticModel. ✅

### Known small gaps (pre-existing, now on the record)

- 🟡 **DocComment**: parser never emits it → `hoverInfo().docComment` is
  always `undefined`; trivia layer is a stub. Fine to defer, but it's a
  *parser* feature — deciding it before the parser port avoids porting the
  gap.
- Diagnostics-as-data is solid: stable `Diagnostic` shape, E0001–E0018 +
  S0001 registry (`errors/diagnostic.ts:60–80`). 🟡 One-page registry doc
  would prevent code-collision during the port (codes are the oracle's
  diff currency).
- 🟡 S1 binding API + code actions + E2 design are shipped-but-undocumented
  in `compiler-as-a-service.md` (S1 only in the parity tracker; E2 design
  doc unlinked).

---

## 5. 🔴 Missing / decisions required before bootstrap

**R1 — Re-decide the native comptime execution strategy.** The plan's
"port the AST-walking interpreter" is no longer possible — it's deleted.
Three real options:

   a. **Static-link T0 handlers (recommended starting point).** Builtin
   strata are fixed at compiler-build time; stage0 can compile every T0
   handler to native code *into* the stage-1 binary (the natural native
   analogue of today's pre-compile pass — same iterate-until-stable
   dependency ordering, same handle ABI). No engine, no interpreter on the
   T0 path. User strata (T1/T2) then need either (b) or (c).

   b. **Write a fresh AST-walking interpreter in Silicon** for T1/T2
   handler bodies. New code with no TS artifact to diff against — its
   conformance oracle is the *compiled* path's behavior, so it needs its
   own equivalence suite (compile each builtin handler both ways, diff
   fired-handler outputs across the corpus).

   c. **Native comptime-via-compilation** for T1/T2: emit QBE → `cc` →
   `dlopen` at compile time. Maximum reuse of the compiler itself; cost is
   a C-toolchain dependency *during* compilation of strata-using programs
   and platform dlopen plumbing.

   The choice gates Phase 2.4's design and should be amended into
   `qbe-self-host-plan.md` (its "risk register" line "resolved — native
   compiler uses the AST-walking interpreter" is now stale).
   *(Note: `bootstrap-blockers-and-order.md` blocker 3 repeated the stale
   premise and is corrected as of this audit.)*

**R2 — Write the authoritative `Compiler::*` spec.** ~85 intrinsics, true
boundary = `imports.ts`; current docs cover only the dead interpreter era
(§3 above). The port cannot be oracle-gated against an unspecified
contract. Cheapest path: generate from `imports.ts` + `IR_HANDLE_ABI.md`.

**R3 — Extract the conformance corpus from TS tests into data.** The oracle
gate (plan Phase 0.1) needs `(program.si, expected exit/stdout, expected IR)`
fixtures runnable by *both* the TS harness and the future Silicon-native
harness. Today that knowledge lives inside ~8,500 LOC of `bun test` files
(`e2e.test.ts`, `backends.test.ts`, `imports.test.ts`, …). Start with the
`BOTH_BACKENDS` corpus; grow per Track-A feature.

**R4 — Trim the dead `Compiler::*` API before porting** (`resolveIntrinsic`,
`unwrapNode`, `lowerBlock`, `choose`; plus delete the stale fallback
comments in `engine.ts:98,137`). Every line removed is a line not ported,
and a smaller frozen surface for R2.

## 6. 🟡 Highly desirable before bootstrap

1. **Green-tree contract in the ported parser from day one** (§4 — the
   retrofit trap). Defer the incremental *algorithms*, not the *positions*.
2. **Handler-equivalence harness** for whichever R1 option is chosen —
   the successor to the "force-interpreter CI mode" recommended in the
   blockers doc (that recommendation is now moot as written, since there is
   no interpreter to force).
3. **Doc debt batch:** regenerate `compiler-api.md` (R2 covers it); add S1
   + code actions + E2-design link to `compiler-as-a-service.md`; add the
   "hardcoded perimeter" list (§2) to `strata.md`; one-page diagnostic-code
   registry.
4. **Decide DocComment** (emit-or-officially-defer) before the parser port.
5. **Pin determinism early:** the fixpoint (stage1 == stage2) and every
   oracle byte-diff assume no hash-order iteration in codegen. The TS
   emitters are deterministic today; carry an explicit "no unordered-map
   iteration in emitters" rule into the port's conventions doc.

## 7. Punch list (ordered)

| # | Item | Size | Unblocks |
|---|---|---|---|
| 1 | R1: comptime strategy decision + amend self-host plan | discussion + doc | Phase 2.4 design |
| 2 | R4: trim dead API + stale comments | ~1 day | smaller R2 surface |
| 3 | R2: authoritative `Compiler::*` spec from `imports.ts` | ~2–3 days | the port contract |
| 4 | R3: corpus extraction (start: `BOTH_BACKENDS`) | incremental | oracle gate (Phase 0.1) |
| 5 | D2: handler-equivalence harness (per R1 choice) | depends on R1 | comptime conformance |
| 6 | D3: doc debt batch | ~1–2 days | port-team onboarding |
| 7 | D4: DocComment decision | small | parser port scope |

None of these is large. The expensive items (QBE parity, the port itself)
are already sequenced in the plan; this audit's conclusion is that the
**foundation needs ~1–2 weeks of decisions, trimming, spec-writing, and
corpus extraction — not new infrastructure — before Track B is safe to
start.** Track A (QBE parity) is unblocked today and unaffected by any of
the above except R3, which it should feed corpus entries into as it goes.
