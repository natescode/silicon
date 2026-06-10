#!/usr/bin/env python3
"""Generate docs/v1.0-implementation-roadmap.html — the ordered build plan for the
FFI gate, monomorphization, and the capability model. Self-contained dark-theme page
mirroring docs/strata-feature-audit.html."""
import html

OUT = "/home/natescode/repos/silicon/docs/v1.0-implementation-roadmap.html"
GEN_DATE = "2026-06-10"

# track → (label, css-class, color var)
TRACKS = {
    "ffi":  ("FFI gate",          "ffi"),
    "mono": ("Monomorphization",  "mono"),
    "cap":  ("Capability model",  "cap"),
}
VERS = {  # version bucket → (label, css-class)
    "v1.0":      ("v1.0 — the gate", "v10"),
    "v1.0-opt":  ("v1.0 (optional)", "v10opt"),
    "v1.1":      ("v1.1",            "v11"),
    "v1.y":      ("v1.y",            "v1y"),
    "post":      ("post-v1.0",       "post"),
}

# Each subtask: id, track, title, desc(html-ok via inline), adr, files, size, risk, unblocks, ver, crit
S = [
    # ---- FFI gate ----
    dict(id="F0a", track="ffi", ver="v1.0", size="L", risk="Med", crit=False, status="done",
         note="First milestone DONE (2026-06-09, ADR 0017 flipped to Accepted). Self-contained: an in-repo hand-authored Tier-0 spec (<code>compiler/bindgen/src/spec.ts</code>) → Binding IR + <code>siToWasm</code> typemap → three emitters (<code>.si</code> @extern block + Bun shim + browser shim). A CLI (<code>bun bindgen/cli.ts --check/--write</code>) splices each fragment between markers in <code>web.si</code> / <code>js-host.ts</code> / <code>web-env.js</code>; generating <b>collapsed the existing drift</b> (js-host ordered <code>math_random</code> last; web.si carried a stray CRLF) into one canonical order/format. <code>bindgen.lock.json</code> pins a content hash; <code>bindgen.test.ts</code> (8 green) enforces byte-for-byte fidelity, cross-site (module,field,arity) key parity, the lock hash, and a round-trip compile of <code>web::math_sqrt</code> (defeats the loader.ts silent-skip). <code>.github/workflows/bindgen.yml</code> gates drift on push/PR + regenerates-via-PR on dispatch. <b>The pipeline then grew to all three boundary tiers + every source</b> (2026-06-10): live <code>@webref/idl</code>+<code>webidl2</code> + Node/Bun <code>.d.ts</code> adapters (TS compiler API); <b>Tier-1</b> <code>JSString</code> strings; <b>Tier-2</b> <code>JSValue</code> object handles (<code>objects:'jsvalue'</code>); shipped modules <code>path</code>/<code>os</code> (Tier-0), <code>bun</code> (Tier-1+2), <code>json</code> (Tier-2 round-trip); <b>constructed Web interfaces</b> via the <code>webiface</code> adapter (<code>url</code>/<code>url_search_params</code>/<code>headers</code>/<code>text_encoder</code>/<code>text_decoder</code> — all 6 IDL shapes constructor/method/getter/setter/static/stringifier, cross-handle threading); and the <b>async</b> (<code>async:'suspending'</code> → <code>@suspending @extern</code>) + <b>event</b> (<code>events:'closure'</code> → <code>Callback</code>) generation modes that feed F1b/C2.",
         title="Bindgen",
         adr="ADR 0017",
         desc="Machine-generate the <code>@extern</code> <code>.si</code> + both host shims from upstream specs (WebIDL for the web — the only source that preserves int-vs-float; <code>.d.ts</code> for Node/Bun), with a <code>bindgen.lock</code> + a CI <code>check-shims</code> test that fails on drift. First slice: regenerate <code>web.si</code> Math/clock byte-for-byte.",
         files="NEW <code>compiler/bindgen/</code>; marker regions in <code>cli/src/host/js-host.ts</code> + <code>playground/playground/web-env.js</code>; <code>compiler/scripts/gen-web-assets.ts</code>; NEW <code>.github/workflows/bindgen.yml</code>",
         unblocks="Anti-drift, on-demand regen. <b>Stays ~10%</b> (doesn't lift the ceiling). Independently buildable."),
    dict(id="F1a", track="ffi", ver="v1.0", size="M", risk="Med", crit=True, status="done",
         note="Done (2026-06-09). <code>JSValue</code> is a generic <code>externref</code> object handle reusing the <code>JSString</code> ref-slot machinery (no <code>wasm:js-string</code> ops). <code>@extern</code> now builds its full IRImport host-side (<code>compiler_expandExtern</code>): a namespaced <code>mod::field</code> name imports from host module <code>mod</code> (callable, forward-ref'd via a lowerProgram pre-scan), and <code>JSString</code>/<code>JSValue</code> params/results become <code>externref</code> slots gated to <code>--platform=web|bun</code>. Bare scalar externs stay byte-identical to <code>(import \"env\" …)</code>. ~1,500 tests green incl. 9 jsvalue cases; modules instantiate under Bun.",
         title="Object handles / JSValue externref",
         adr="ADR 0018 · P0/P1",
         desc="Generalize the <code>JSString</code>-only externref path to a generic <code>JSValue</code> object handle, so a <code>Response</code>/<code>Uint8Array</code>/DOM node has a type to land in.",
         files="<code>compiler/src/ir/lower.ts</code> (<code>siliconTypeNameToWasm</code>, <code>isExternRefKind</code>, <code>injectExternRefSlots</code>, new <code>lowerExternImport</code> + <code>externCalls</code> routing in <code>lowerModuleCall</code>); <code>compiler-api/index.ts</code> + <code>comptime/imports.ts</code> (<code>expandExtern</code>/<code>compiler_expandExtern</code>); <code>strata/defkinds.si</code> <code>ExternDef_lower</code> delegates host-side (import-module override, not hardcoded <code>'env'</code>); <code>types/types.ts</code> + <code>unify.ts</code> (<code>JSValue</code> kind)",
         unblocks="Sync object-returning APIs; lifts bindgen scalar→object tier. <b>~10% → ~35%</b>"),
    dict(id="F1b", track="ffi", ver="v1.0", size="L", risk="High", crit=True, status="done",
         note="DONE (2026-06-10) — blocking <code>@await</code> productized end-to-end, dual-backend. Shipped: (1) the <code>@await(expr)</code> surface stratum (<code>control.si</code>, transparent + typed to its arg) and the <code>@async</code>/<code>@suspending</code> signature-line markers (<b>no grammar change</b>, parsed in the modifier loop). (2) The coloring rule <b>E0016</b> (<code>AwaitOutsideAsync</code>): <code>@await</code> only inside an <code>@async</code> body, inherited by nested <code>@local</code> bindings. (3) The Binaryen Asyncify transform (<code>applyAsyncify</code>) with <b>route-B precise coloring</b> (<code>suspendingImports</code> — instruments only functions reaching a suspending import). (4) The <b>production reactor</b> <code>runWithReactor</code> (<code>codegen/async-reactor.ts</code>) chooses the backend at LOAD time from one vanilla binary: the <b>JSPI fast path</b> (<code>WebAssembly.Suspending</code>/<code>promising</code> — <b>Bun 1.3.14 ships JSPI</b>, <code>bun#20878</code> resolved) else the Asyncify unwind→await→rewind loop. (5) <code>sgl run</code> wiring: <code>compile()</code> reports <code>suspendingImports</code>; <code>runUnderBun</code> drives a <code>@suspending</code>-using program through the reactor. (6) <b>Async host APIs via bindgen</b>: <code>dtsToSpecs({async:'suspending'})</code> turns a <code>Promise&lt;T&gt;</code> method into a <code>@suspending @extern</code> (awaited <code>T</code>); the <code>bun</code> module ships async methods, driven end-to-end (<code>async-production.test.ts</code>, <code>async-modules.test.ts</code>). Known engine constraint (not a gap): Binaryen Asyncify can't carry <code>externref</code> (binaryen#3739), so externref-valued awaits need JSPI; the Asyncify fallback covers scalar awaits. ADR 0018 Accepted.",
         title="Blocking @await (Asyncify) + reactor host + async effect",
         adr="ADR 0018 · P1/P2-host/P3/P5",
         desc="<code>@async</code>/<code>@await</code>/<code>@suspending</code> strata (no grammar change); the Asyncify unwind/rewind transform; the one-shot host → a reactor; an <code>async</code> effect tag. <b>Portable incl. Bun</b> — JSPI is absent in JSC, so Asyncify is the permanent floor.",
         files="NEW strata in <code>strata/control.si</code>; Asyncify pass (Binaryen v117 is already a dep, then an IR pass sibling to <code>loopDesugar</code>); <code>js-host.ts</code> <code>runUnderBun</code> ~100 → reactor; <code>web-env.js</code> <code>startGameLoop</code> → reactor; ADR 0012 lattice <code>+async</code>",
         unblocks="<b>All</b> Promise APIs on Bun today (<code>fetch</code>/<code>.json()</code>/timers/<code>crypto.subtle</code>). <b>~35% → ~80%</b>"),
    dict(id="C0", track="ffi", ver="v1.0", size="M", risk="Low-Med", crit=True, status="done",
         note="Done (2026-06-09, commit 73c6337). <code>@call_indirect(cb, …args)</code> is variadic; a host expander derives the sigKey from the args' wasm types and registers it in the multi-signature table. i32→i32 stays byte-identical; new multi-sig test dispatches a (Int,Int)→Int fn → 42. ~1,545 tests green.",
         title="Generalize the funcref ABI  (closures C0)",
         adr="ADR 0019 · C0",
         desc="Stop forcing <code>__fn_i_i</code>: derive <code>sigKey</code> from the <code>@fn</code>'s real param/result wasm types; multi-signature funcref table; relax the arity-2 guard. <b>Built directly on the <code>funcref.si</code> surface dissolved earlier.</b>",
         files="<code>compiler/src/strata/funcref.si</code>; <code>compiler/src/compiler-api/index.ts</code> (<code>expandCallIndirect</code>); <code>compiler/src/comptime/imports.ts</code> (the funcref/call_indirect path now lives in strata, not the old <code>lower.ts:1584/1620</code>)",
         unblocks="C1; funcref-at-boundary. Pure refactor — kept byte-equal codegen for non-funcref / i32→i32 programs."),
    dict(id="C1", track="ffi", ver="v1.0", size="L", risk="Med", crit=True, status="done",
         note="DONE (2026-06-09). <code>@closure(body_fn, …caps)</code> / <code>@call_closure(clo, …args)</code> as one AST→AST elaborator pass (<code>closureDesugar.ts</code>, loopDesugar model) — <b>zero new IR / codegen / grammar</b>. A closure is an i32 pointer to a <code>Vec[i32]</code> env <code>[fnref, …caps]</code>; each site synthesizes an env-unpack wrapper <code>@fn(env, …args)</code> so every closure shares one uniform <code>(env,…args)→ret</code> <code>call_indirect</code> signature; <code>@call_closure</code> loads the wrapper index from slot 0 and dispatches env-first over the C0 multi-sig table. Runs on EVERY mode. 5 closure.test.ts cases run real WASM (single/double capture, empty-env, coexisting closures, and a closure passed to a combinator — the ADR 0016 gap). Scope shipped = correct call_indirect baseline for i32 captures; the per-concrete-env-type monomorphized DIRECT-call zero-cost form (§2.1) + Float captures are refinements on top.",
         title="Non-escaping closures (all modes, zero-cost)  (closures C1)",
         adr="ADR 0019 · C1",
         desc="<code>&@closure</code>/<code>&@call_closure</code>; lambda-lift in the elaborator; anonymous-struct env in frame/arena; <b>per-concrete-env-type consumer specialization (uses M0)</b> → a direct call; empty-env degenerates to today's <code>@fnref</code>. By-value/<code>&</code>-immutable capture only — <b>does NOT require the borrow checker</b>.",
         files="NEW closure strata alongside <code>control.si</code>; elaborator lambda-lift modeled on <code>elaborator/loopDesugar.ts</code>; <b>reuses M0</b>",
         unblocks="ADR 0016 combinators <code>map</code>/<code>filter</code>/<code>fold</code> (with M1) on every mode. <b>Needs M0 + C0</b>"),
    dict(id="C2", track="ffi", ver="v1.0", size="L", risk="High", crit=True, gate=True, status="done",
         note="DONE (2026-06-10) — escape gate + host-callable closures end-to-end, INCLUDING the leak-free wasm-gc form. (1) The conservative escape/host-reachability classifier + mode-gate (<code>classifyEscapes</code>): a BARE <code>@closure</code> crossing <code>@extern</code> is rejected, pointing at <code>@export_callback</code>. (2) <b>Host-callable closures</b>: <code>@export_callback(closure)</code> (the sanctioned, gate-exempt escape) hands a closure's handle across <code>@extern</code> to a JS/Bun host, which stores it and calls it back later via a synthesized exported <code>__closure_invoke_&lt;k&gt;</code> trampoline with the captured env intact — <b>verified round-trip under Bun</b> (<code>register(7)</code> → host holds handle → <code>__closure_invoke_1(handle, 5)</code> = 35). (3) <b>Under <code>--target=wasm-gc</code> the env is a <code>(ref $Vec_i32)</code> the engine GCs — leak-free, no bump-heap retention</b> (commit 75f3ac2): the C0 funcref ABI was extended to carry ref-typed (<code>(ref $Vec_i32)</code>) params so <code>@call_indirect</code>'s type matches the ref-typed wrapper; an escaping closure crosses <code>@extern</code> as a real wasm-gc ref (<code>typeof handle === 'object'</code>, not i32), collected when the host drops it. C1 + C2 run under wasm-gc (<code>closure-wasm-gc.test.ts</code>). The 3 GC ref-conversion ops the ADR named absent (<code>ExternConvertAny</code>/<code>AnyConvertExtern</code>/<code>RefCast</code>) are implemented + proven (<code>gc-closure-box.test.ts</code>). (4) <b>Event/callback host APIs via bindgen</b>: <code>dtsToSpecs({events:'closure'})</code> maps a callback param to the <code>Callback</code> closure-handle type; the host invokes it via <code>makeClosureToFn</code> → the trampoline (<code>event-modules.test.ts</code>). The default linear-memory target still retains the env in the bump heap (a bounded, documented cost); wasm-gc removes it. ADR 0019 Accepted.",
         title="Escaping host-callable closures — wasm-gc only  (closures C2 · THE GATE)",
         adr="ADR 0019 · C2 / 0018 · P3",
         desc="<code>(type $Clo (struct (i32 fnIndex)(ref $Env)))</code>; an <code>__invoke_&lt;sig&gt;(externref,…)</code> trampoline; <code>&@on</code>/<code>&@off</code> over the engine-traced externref; <code>@extern</code> externref/funcref slot; the conservative <b>escape/host-reachability classifier</b> (routes any closure reaching <code>@extern</code> to Tier B, rejects on <code>wasm-mvp</code>/<code>--native</code> with a mode-gate E-code). Engine-GC'd — no leak, cycles collected, <code>__closure_release</code> is a no-op. Verified Bun/JSC runs wasm-gc today; v1.0 invocation reuses the existing <code>call_indirect</code> (no JSPI dep).",
         files="<code>lower.ts</code> (wasm-gc struct env + externref trampoline export); NEW escape classifier; <code>@export_callback</code> keyword stratum",
         unblocks="Callbacks/events (<code>addEventListener</code>, <code>setTimeout(cb)</code>, <code>onmessage</code>, <code>EventTarget</code>, <code>.on('data')</code>). <b>~80% → ~97% — THE GATE CLOSES.</b> Needs C1"),
    dict(id="F3", track="ffi", ver="v1.0", size="L", risk="Med", crit=True, status="done",
         note="CORE done (2026-06-09) — the poll-reactor proven end-to-end. <code>stdlib/future.si</code>: a FUTURE is a no-arg C1 closure over a mutable poll-state pointer that returns a PENDING sentinel until ready; <code>block_on</code> drives one to completion, and <code>block_all</code> drives MANY <b>concurrently</b> — each round polls every still-pending future, so independent futures progress interleaved (the true-concurrency model single-in-flight Asyncify can't express). <code>future.test.ts</code>: block_on (single), block_all (3 futures, deadlines 2/4/3 → 60, polled interleaved), and fast+slow independent progress (→107). Reuses the C1/C2 closure keystone as wake continuations — the reason this waited on closures. <b>DONE (2026-06-10) — the native poll-reactor is complete on all three remaining axes.</b> (1) <b>Generic <code>Poll[T] := $Pending | $Ready value T</code></b> in <code>future.si</code> + <code>block_on_poll</code>/<code>block_all_poll</code>: the variant tag (not the sign) marks readiness, so the old negative-sentinel constraint is gone — a future may be <code>Ready</code> with ANY value (a <code>Ready(-9)</code> test proves it). (2) <b>spawn / task-set / drain</b>: <code>tasks_new</code>/<code>spawn</code>/<code>poll_once</code> (the microtask-drain step)/<code>run_tasks</code> — a dynamic task surface over the poll loop. (3) <b>Future ↔ host Promise bridge</b> (<code>stdlib/future_async.si</code>): a guest <code>Future</code> backed by a REAL host Promise, woken by the F1b reactor — <code>promise::track</code>/<code>settled</code>/<code>result</code> watch a Promise non-blockingly and <code>@suspending promise::tick</code> yields one event-loop turn between poll rounds so it settles; <code>block_on_async</code> drives one and <code>block_all_async</code> drives MANY concurrently (a delayed-Promise test proves the wake; a 2-future test proves guest-side concurrency, max-in-flight = 2). The earlier post-gate <code>promise</code> module (host-delegated <code>all</code>/<code>race</code>/…) remains the convenience path; <code>future_async</code> is the native guest-side one. (A closure-desugar bug — wrappers dropped a body's parametric return type, e.g. <code>-> Poll[Int]</code> became bare <code>Poll</code> — was fixed en route.) Single-in-flight Asyncify (<code>@await</code>) still serves simple sequential awaits; the poll-reactor is the many-in-flight path.",
         title="Poll-reactor + tasks  (closures C3)",
         adr="ADR 0018 · P4 / 0019 · C3",
         desc="<code>Future[T]</code> sum (<code>$Pending waker | $Ready value</code>), <code>spawn</code>/<code>block_on</code>, microtask drain, many in-flight awaits. Reuses C1/C2 closures as wake continuations.",
         files="stdlib <code>Future[T]</code>; reactor host generalization",
         unblocks="True concurrency, <code>Promise.all</code>-shaped composition, streaming events. <b>~97% → 100%</b>. Needs C2"),
    dict(id="F3-opt", track="ffi", ver="v1.0-opt", size="M", risk="Low", crit=False, status="done",
         title="JSPI fast path",
         adr="ADR 0018 · P2",
         note="DONE (2026-06-10) — shipped INSIDE the F1b reactor. <code>runWithReactor</code> feature-detects JSPI (<code>hasJSPI()</code> — <code>WebAssembly.Suspending</code> + <code>promising</code>) and on engines that have it (<b>Bun 1.3.14</b> now does, plus V8/Node 24+/Deno) runs the unchanged vanilla binary with a <code>Suspending</code>-wrapped import + a <code>promising</code> entry — no Asyncify transform, no size tax — else falls back to Asyncify route-B. Same <code>@await</code> surface, a load-time backend choice. It is also REQUIRED (not just an optimization) for externref-valued awaited results, which Asyncify can't carry (binaryen#3739).",
         desc="Loader feature-detects <code>WebAssembly.promising</code>; emit a plain <code>call</code> + promising export on V8/Node/Deno (and JSC once it ships). Same <code>@await</code> surface — flip a flag.",
         files="loader glue only",
         unblocks="No new coverage — erases the Asyncify size/perf tax on V8/Node. A detect-and-upgrade, never a hard dep. Slots in any time after F1a."),
    # ---- Monomorphization ----
    dict(id="M0", track="mono", ver="v1.0", size="L", risk="Med", crit=True, status="done",
         note="Substrate DONE (2026-06-09). Reframed the earlier 'blocked' diagnosis: a <code>@generic</code> inline-block <code>on::decl</code>/<code>on::call_site</code> handler DID register + fire all along (the compiled engine auto-extracts inline blocks). The real gaps were substrate defects, now fixed: (1) <code>module::push_definition</code> was stranded in the per-firing <code>env.pendingDefinitions</code> — added <code>drainModuleMutations</code> in every firing wrapper so pushed monomorphs reach <code>registry.pendingDefinitions</code>; (2) the block translator tracked only <code>@local</code>, not <code>@mut</code>, and emitted <code>&lt;local&gt;::field</code> verbatim — now tracks <code>@mut</code> and routes field access through <code>compiler_ast_node_field</code>; (3) handler envs each had their own handle table, so a template handle stored at <code>on::decl</code> was unreadable at <code>on::call_site</code> — now ONE registry-shared handle table; (4) the <code>state('stratum')</code> bucket always resolved to <code>__global__</code> — fixed; (5) added the missing compiled-engine primitives <code>callee_name</code>, <code>type_bind_template_args</code>, <code>str_concat</code>. <b>Proven end-to-end</b> (generic-e2e.test.ts ×6 + generic-monomorph-substrate.test.ts ×4): a Silicon stratum captures a template, hands it across handler firings via shared state, infers the call's type args, and emits a real <code>$id$Int</code>/<code>$id$Float</code> monomorph with substituted param/result types + a rewritten call that RUNS under WASM. <b>Remaining tail</b> (the full generic-monomorph.test.ts ×4, still skipped): same-type call-site memoization needs comptime conditionals (<code>@if</code>/<code>@not</code>/<code>!=</code>/<code>@nil</code>) + string <code>+</code> in compiled handlers, plus a multi-push call-site-triggered lowering re-entrancy edge.",
         title="Comptime monomorphization substrate",
         adr="ADR 0003 · C-1 / 0001 · G-1 core",
         desc="Audit/wire the comptime API coverage (<code>ast::capture_template</code>/<code>patch_types</code>/<code>with_name</code>/<code>rewrite_call</code>, <code>type::bind_template_args</code>/<code>mangle_suffix</code>); unskip the <code>@generic</code> stratum (9 skipped tests); make the <code>on::call_site</code> wildcard fire + state-memoized monomorph-per-(template, type-args). <b>Pulled into v1.0 because closures C1 need it.</b>",
         files="<code>strata/modules/compiler.si</code>; <code>comptime/imports.ts</code> + the strata loader's on::decl/on::call_site registration (<code>elaborator/strataLoader.ts</code>); tests <code>elaborator/generic-monomorph.test.ts:103-187</code>, <code>generic-e2e.test.ts:62-174</code>",
         unblocks="<b>Shared mechanism: closures C1 (env specialization) AND M1 (containers).</b>"),
    dict(id="M1", track="mono", ver="v1.1", size="L", risk="Med", crit=False,
         title="Container monomorphization — Vec[T] / HashMap[K,V]",
         adr="ADR 0001 · G-1 / 0016",
         desc="Structural constraint protocol (comptime <code>sizeof[T]</code>/hashable check at <i>instantiation</i>, Zig-style — not at definition); emit monomorphic Vec/HashMap variants per element/(K,V) type; a HashMap iteration surface (<code>IterStep</code>).",
         files="<code>stdlib/vec.si</code> (i32-only; <code>vec_map_i32_i32</code> is the template), <code>stdlib/hashmap.si</code> (i32→i32, no iteration), <code>slice.si</code>; <code>codegen/gc-vec.ts</code> (Vec[Int] only; Float/Int64 stubbed)",
         unblocks="<code>Vec[Float]</code>/<code>Vec[Int64]</code>; HashMap iteration; ADR 0016 <code>IterStep</code> dispatch; combinators (with C1). The “dominant speed lever.” <b>Needs M0</b>"),
    # ---- Capability model ----
    dict(id="K1", track="cap", ver="post", size="M", risk="Low", crit=False,
         title="on::check phase hook",
         adr="ADR 0013 · P1",
         desc="Add <code>'check'</code> to <code>StratumPhase</code>; fire per-module after typecheck, before lowering; pass the typed AST + imported sigs + <code>typeMap</code>.",
         files="<code>elaborator/registry.ts</code> (<code>StratumPhase</code> ~63; <code>handlers</code> maps ~114-129 add <code>check:</code>); <code>strataLoader.ts</code> dispatch",
         unblocks="<b>All</b> capability/effect work (K2–K8) + ADR 0015 ocaps. The substrate gate."),
    dict(id="K2", track="cap", ver="post", size="M", risk="Low", crit=False,
         title="AST reflection primitives",
         adr="ADR 0013 · P2",
         desc="<code>ast_inferred_type</code>, <code>ast_callee</code>, <code>is_construction</code>, <code>symbol_module</code>.",
         files="<code>comptime/imports.ts</code> + <code>strata/modules/compiler.si</code> + <code>wit/comptime.wit</code>",
         unblocks="K4, K5"),
    dict(id="K3", track="cap", ver="post", size="S-M", risk="Low", crit=False,
         title="Comptime collections",
         adr="ADR 0013 · P3",
         desc="Map/Set/Worklist for the checker's fixpoint (host-side interim, then stdlib).",
         files="<code>comptime/imports.ts</code> (interim JS)",
         unblocks="K4"),
    dict(id="K4", track="cap", ver="post", size="L", risk="Med", crit=False,
         title="Capability/effect checker prototype (TS)",
         adr="ADR 0013 · P4a",
         desc="Bottom-up union of callees' required caps + <code>@extern</code> tags ⇒ a fixpoint over the call graph; reject when a required capability isn't reachable; emit <code>capabilityMap</code>.",
         files="<code>comptime/</code> (new)",
         unblocks="K6, K7. De-risks the analysis rules before the Silicon port."),
    dict(id="K5", track="cap", ver="post", size="M", risk="Med", crit=False,
         title="@capability stratum + ocap mint-site rule",
         adr="ADR 0015 / 0013 · P5",
         desc="<code>@capability Console;</code> declares a nominal capability; an <code>on::check</code> rule rejects construction outside the issuer module (unforgeability leg 1).",
         files="NEW <code>strata/modules/capabilities.si</code>",
         unblocks="Ocaps, no-ambient-authority. Needs K1 + K2"),
    dict(id="K6", track="cap", ver="post", size="M-L", risk="Med", crit=False,
         title="Port checker into Silicon (dogfood)",
         adr="ADR 0013 · P4b",
         desc="Rewrite K4 as a Silicon <code>@fn</code> handler over K2 reflection + K3 collections + K5 registry.",
         files="<code>strata/modules/capabilities.si</code>",
         unblocks="Self-hosting alignment"),
    dict(id="K7", track="cap", ver="post", size="M-L", risk="Med", crit=False,
         title="Effect-class consumption by the optimizer",
         adr="ADR 0012",
         desc="Add <code>effectClass: pure|mut|effectful</code> to the per-module symbol record; the optimizer reads it for CSE/LICM/in-placing (<code>pure ≙ no mutation rcap ∧ no effect ocap</code>).",
         files="<code>caas</code> MetadataReference; optimizer stage",
         unblocks="The perf payoff of the effect lattice"),
    dict(id="K8", track="cap", ver="v1.y", size="XL", risk="High", crit=False,
         title="Borrow checker / rcaps R1–R4",
         adr="ADR 0011",
         desc="<code>&</code>/<code>&mut</code>/<code>&uniq</code>/<code>&val</code>; R1 scope, R2 aliasing, R3 cross-actor upgrade, R4 escape promotion; the Span/View/Slice rename (ADR-0011 addendum). <b>“Extremely low priority.”</b>",
         files="typechecker; <code>stdlib/slice.si</code> rename",
         unblocks="Mutable capture in escaping closures; data-race-free concurrency; free-without-arena-exit; the Span/View/Slice surface"),
]

# The phase ladder (timeline). Each phase: title, note, list of (id, track) chips.
PHASES = [
    ("Phase 0", "Foundations — no inter-dependencies, run in parallel", ["F0a", "M0", "C0"]),
    ("Phase 1", "FFI to ~80% (async) + container mono — parallel", ["F1a", "F1b", "M1"]),
    ("Phase 2", "The keystone — closures (the FFI↔mono join)", ["C1", "C2"]),
    ("Phase 3", "FFI to 100%", ["F3", "F3-opt"]),
    ("Phase 4", "Capability model — post-v1.0 (strict P-chain)", ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8"]),
]

BYID = {s["id"]: s for s in S}

def chip(sid):
    s = BYID[sid]
    cls = TRACKS[s["track"]][1]
    gate = " gate" if s.get("gate") else ""
    crit = " crit" if s.get("crit") else ""
    status = s.get("status", "todo")
    stcls = f" chip-{status}" if status in ("done", "blocked", "partial") else ""
    mark = {"done": "✓ ", "blocked": "⚠ ", "partial": "◐ "}.get(status, "")
    return f'<a href="#{s["id"]}" class="chip {cls}{gate}{crit}{stcls}" title="{html.escape(strip(s["title"]))}"><b>{mark}{s["id"]}</b> {html.escape(strip_short(s["title"]))}</a>'

def strip(t):
    import re
    return re.sub("<[^>]+>", "", t)

def strip_short(t):
    base = strip(t).split("(")[0].split("—")[0].strip()
    return (base[:30] + "…") if len(base) > 31 else base

def size_badge(sz):
    cls = {"S": "s", "S-M": "s", "M": "m", "M-L": "l", "L": "l", "XL": "xl"}.get(sz, "m")
    return f'<span class="sz sz-{cls}">{sz}</span>'

def risk_badge(r):
    cls = "lo" if r.startswith("Low") else "hi" if r.startswith("High") else "md"
    return f'<span class="rk rk-{cls}">{r}</span>'

def row(s):
    vlabel, vcls = VERS[s["ver"]]
    gate = ' <span class="gatetag">GATE</span>' if s.get("gate") else ""
    crit = ' <span class="crittag">critical path</span>' if s.get("crit") else ""
    status = s.get("status", "todo")
    stbadge = {"done": ' <span class="st st-done">✓ DONE</span>',
               "blocked": ' <span class="st st-blocked">⚠ BLOCKED</span>',
               "partial": ' <span class="st st-partial">◐ PARTIAL</span>'}.get(status, "")
    note = f'<div class="tnote tnote-{status}">{s["note"]}</div>' if s.get("note") else ""
    return f"""<tr id="{s['id']}" class="t-{TRACKS[s['track']][1]} v-{vcls} status-{status}">
  <td class="cid"><span class="idbadge {TRACKS[s['track']][1]}">{s['id']}</span></td>
  <td class="ctitle"><div class="tt">{s['title']}{stbadge}{gate}{crit}</div>
      <div class="tdesc">{s['desc']}</div>
      {note}
      <div class="tfiles"><span class="k">Files</span> {s['files']}</div>
      <div class="tunb"><span class="k">Unblocks</span> {s['unblocks']}</div></td>
  <td class="cadr">{html.escape(s['adr'])}</td>
  <td class="cmeta">{size_badge(s['size'])}{risk_badge(s['risk'])}<span class="ver ver-{vcls}">{vlabel}</span></td>
</tr>"""

def item_table(track_key, heading, blurb, ids):
    rows = "\n".join(row(BYID[i]) for i in ids)
    return f"""<section class="prose">
<h2 class="sec" id="item-{track_key}"><span class="dot {TRACKS[track_key][1]}"></span>{heading}</h2>
<p class="blurb">{blurb}</p>
<table class="rt">
<thead><tr><th>#</th><th>Subtask</th><th>ADR · phase</th><th>Size · risk · version</th></tr></thead>
<tbody>
{rows}
</tbody></table>
</section>"""

# ---- counts ----
n_total = len(S)
n_crit = sum(1 for s in S if s.get("crit"))
n_v10 = sum(1 for s in S if s["ver"].startswith("v1.0"))
n_done = sum(1 for s in S if s.get("status") == "done")

# ---- timeline ladder ----
ladder = ""
for title, note, ids in PHASES:
    chips = "".join(chip(i) for i in ids)
    ladder += f"""<div class="phase">
  <div class="phead"><span class="pnum">{title}</span><span class="pnote">{note}</span></div>
  <div class="pchips">{chips}</div>
</div>"""

legend = "".join(
    f'<span class="lg"><span class="dot {cls}"></span>{label}</span>'
    for label, cls in [(TRACKS["ffi"][0], "ffi"), (TRACKS["mono"][0], "mono"), (TRACKS["cap"][0], "cap")]
) + '<span class="lg"><span class="dot crità"></span>critical path</span>'

HTML = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Silicon — v1.0 Implementation Roadmap</title>
<style>
  :root {{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2230; --border:#2a3140;
    --fg:#e6edf3; --muted:#8b97a7; --faint:#6b7585;
    --ffi:#58a6ff; --mono:#3fb950; --cap:#a371f7;
    --gate:#f7b955; --crit:#f778ba; --accent:#a371f7;
    --v10:#3fb950; --v10opt:#58a6ff; --v11:#d29922; --v1y:#8b949e; --post:#8b949e;
  }}
  * {{ box-sizing:border-box; }}
  html {{ scroll-behavior:smooth; }}
  body {{ margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }}
  code {{ background:#1f2733; color:#9ad1ff; padding:1px 5px; border-radius:5px;
    font:0.85em/1.4 "SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace; word-break:break-word; }}
  a {{ color:var(--ffi); text-decoration:none; }}
  .wrap {{ max-width:1180px; margin:0 auto; padding:0 22px 80px; }}

  header.hero {{ padding:54px 0 26px; border-bottom:1px solid var(--border);
    background:radial-gradient(1100px 360px at 12% -10%, rgba(163,113,247,.16), transparent 60%),
               radial-gradient(900px 320px at 95% -20%, rgba(88,166,255,.12), transparent 55%); }}
  .eyebrow {{ color:var(--accent); font-weight:700; letter-spacing:.14em; text-transform:uppercase; font-size:12px; }}
  h1 {{ margin:.3em 0 .15em; font-size:34px; line-height:1.12; letter-spacing:-.02em; }}
  .thesis {{ color:var(--muted); font-size:17px; max-width:880px; }}
  .thesis b {{ color:var(--fg); }}
  .meta {{ margin-top:14px; color:var(--faint); font-size:13px; }} .meta b {{ color:var(--muted); }}
  .tiles {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:24px 0 6px; }}
  .tile {{ background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:15px 14px; text-align:center; }}
  .tile .num {{ font-size:28px; font-weight:800; letter-spacing:-.02em; }}
  .tile .lbl {{ color:var(--muted); font-size:12px; margin-top:3px; line-height:1.3; }}
  .tile.gate .num {{ color:var(--crit); }} .tile.v10 .num {{ color:var(--v10); }} .tile.done .num {{ color:var(--mono); }}
  .legend {{ display:flex; flex-wrap:wrap; gap:16px; color:var(--muted); font-size:13px; margin-top:14px; }}
  .lg {{ display:inline-flex; align-items:center; gap:7px; }}
  .dot {{ width:11px; height:11px; border-radius:50%; display:inline-block; }}
  .dot.ffi {{ background:var(--ffi); }} .dot.mono {{ background:var(--mono); }} .dot.cap {{ background:var(--cap); }}
  .dot.crità {{ background:var(--crit); }}

  nav.toc {{ position:sticky; top:0; z-index:20; background:rgba(13,17,23,.93); backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border); padding:11px 0; }}
  nav.toc .wrap {{ padding-bottom:0; padding-top:0; display:flex; gap:6px; flex-wrap:wrap; }}
  nav.toc a {{ color:var(--muted); font-size:13px; padding:5px 11px; border-radius:7px; }}
  nav.toc a:hover {{ background:var(--panel2); color:var(--fg); }}

  section {{ margin:30px 0; }}
  h2.sec {{ font-size:23px; margin:36px 0 10px; padding-top:10px; letter-spacing:-.01em;
    border-top:1px solid var(--border); display:flex; align-items:center; gap:10px; }}
  h2.sec:first-child {{ border-top:none; }}
  .blurb {{ color:var(--muted); margin:0 0 14px; max-width:880px; }}

  /* timeline ladder */
  .ladder {{ display:flex; flex-direction:column; gap:12px; margin:18px 0 6px; }}
  .phase {{ background:var(--panel); border:1px solid var(--border); border-left:3px solid var(--accent);
    border-radius:12px; padding:14px 16px; }}
  .phead {{ display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:10px; }}
  .pnum {{ font-weight:800; font-size:15px; letter-spacing:.02em; }}
  .pnote {{ color:var(--muted); font-size:13px; }}
  .pchips {{ display:flex; flex-wrap:wrap; gap:8px; }}
  .chip {{ display:inline-flex; align-items:center; gap:6px; font-size:12.5px; padding:5px 11px; border-radius:20px;
    border:1px solid var(--border); background:#11161f; color:var(--fg); }}
  .chip b {{ font-family:ui-monospace,monospace; font-size:11.5px; }}
  .chip.ffi {{ border-color:#234; box-shadow:inset 3px 0 0 var(--ffi); }}
  .chip.mono {{ box-shadow:inset 3px 0 0 var(--mono); }}
  .chip.cap {{ box-shadow:inset 3px 0 0 var(--cap); }}
  .chip.crit {{ outline:1px solid rgba(247,120,186,.5); }}
  .chip.gate {{ background:linear-gradient(90deg, rgba(247,185,85,.18), #11161f); border-color:var(--gate); }}
  .critline {{ margin:14px 0 0; padding:12px 16px; border:1px solid #4a2f3e; border-radius:10px;
    background:linear-gradient(180deg, rgba(247,120,186,.08), rgba(247,120,186,.02)); color:#f2c3da; font-size:14px; }}
  .critline code {{ background:#2a1722; color:#ffd0e6; }}

  /* roadmap tables */
  table.rt {{ width:100%; border-collapse:collapse; margin:8px 0 6px; }}
  table.rt th {{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--faint);
    border-bottom:1px solid var(--border); padding:8px 10px; background:var(--panel2); }}
  table.rt td {{ border-bottom:1px solid var(--border); padding:13px 10px; vertical-align:top; }}
  tr[id] {{ border-left:3px solid transparent; }}
  tr.t-ffi td.cid {{ box-shadow:inset 3px 0 0 var(--ffi); }}
  tr.t-mono td.cid {{ box-shadow:inset 3px 0 0 var(--mono); }}
  tr.t-cap td.cid {{ box-shadow:inset 3px 0 0 var(--cap); }}
  .idbadge {{ font-family:ui-monospace,monospace; font-size:12px; font-weight:700; padding:3px 8px; border-radius:7px;
    background:#11161f; border:1px solid var(--border); white-space:nowrap; }}
  .idbadge.ffi {{ color:var(--ffi); }} .idbadge.mono {{ color:var(--mono); }} .idbadge.cap {{ color:var(--cap); }}
  td.cid {{ width:62px; }}
  .tt {{ font-weight:650; font-size:15px; margin-bottom:6px; }}
  .gatetag {{ font-size:10px; font-weight:800; color:#0d1117; background:var(--gate); padding:1px 7px; border-radius:6px; letter-spacing:.04em; }}
  .crittag {{ font-size:10px; font-weight:700; color:var(--crit); border:1px solid #4a2f3e; padding:1px 7px; border-radius:6px; }}
  .st {{ font-size:10px; font-weight:800; padding:1px 7px; border-radius:6px; letter-spacing:.04em; }}
  .st-done {{ color:#0d1117; background:var(--mono); }}
  .st-blocked {{ color:#0d1117; background:var(--gate); }}
  .st-partial {{ color:#0d1117; background:#d6a700; }}
  .chip-done {{ border-color:var(--mono); }} .chip-blocked {{ border-color:var(--gate); }}
  .chip-partial {{ border-color:#d6a700; }}
  tr.status-done td.cid {{ box-shadow:inset 3px 0 0 var(--mono) !important; }}
  tr.status-blocked td.cid {{ box-shadow:inset 3px 0 0 var(--gate) !important; }}
  tr.status-partial td.cid {{ box-shadow:inset 3px 0 0 #d6a700 !important; }}
  .tnote {{ font-size:12.5px; margin:8px 0; padding:9px 12px; border-radius:8px; line-height:1.5; }}
  .tnote code {{ background:#11161f; }}
  .tnote-done {{ background:rgba(63,185,80,.08); border:1px solid #1f4427; color:#bfe6c8; }}
  .tnote-blocked {{ background:rgba(247,185,85,.08); border:1px solid #4a3a1e; color:#f0d9a8; }}
  .tdesc {{ color:#d2dae4; font-size:14px; margin-bottom:8px; }}
  .tfiles, .tunb {{ font-size:12.5px; color:var(--muted); margin-top:5px; }}
  .tfiles .k, .tunb .k {{ display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.06em;
    color:var(--faint); margin-right:6px; }}
  .tunb b {{ color:var(--fg); }}
  td.cadr {{ width:140px; color:var(--muted); font-size:13px; white-space:nowrap; }}
  td.cmeta {{ width:150px; }}
  .sz {{ display:inline-block; font-size:11px; font-weight:700; padding:2px 7px; border-radius:6px; margin:0 6px 6px 0; }}
  .sz-s {{ background:#16331f; color:#5cd17e; }} .sz-m {{ background:#16283f; color:#7db8ff; }}
  .sz-l {{ background:#3a2a14; color:#e0a64e; }} .sz-xl {{ background:#3a1620; color:#f77b9e; }}
  .rk {{ display:inline-block; font-size:11px; padding:2px 7px; border-radius:6px; margin:0 6px 6px 0; border:1px solid var(--border); }}
  .rk-lo {{ color:#5cd17e; }} .rk-md {{ color:#e0a64e; }} .rk-hi {{ color:#f77b9e; }}
  .ver {{ display:inline-block; font-size:11px; font-weight:700; padding:2px 8px; border-radius:6px; }}
  .ver-v10 {{ background:#16331f; color:#5cd17e; }} .ver-v10opt {{ background:#16283f; color:#7db8ff; }}
  .ver-v11 {{ background:#3a2e14; color:#e0c04e; }} .ver-v1y {{ background:#262b36; color:#aab2c4; }}
  .ver-post {{ background:#262b36; color:#aab2c4; }}

  .callout {{ background:linear-gradient(180deg, rgba(163,113,247,.08), rgba(163,113,247,.02));
    border:1px solid #34304a; border-left:3px solid var(--accent); border-radius:10px; padding:14px 18px; margin:16px 0; }}
  .callout h4 {{ margin:0 0 8px; font-size:14px; color:#cdb8ff; }}
  .callout ul {{ margin:6px 0 0; padding-left:20px; }} .callout li {{ margin:6px 0; color:#d2dae4; }}
  footer {{ border-top:1px solid var(--border); margin-top:50px; padding:24px 0; color:var(--faint); font-size:13px; }}
  @media (max-width:880px) {{ .tiles {{ grid-template-columns:repeat(2,1fr); }} td.cadr,td.cmeta {{ width:auto; }} h1 {{ font-size:27px; }} }}
</style>
</head>
<body>
<header class="hero"><div class="wrap" style="padding-bottom:0">
  <div class="eyebrow">Silicon · v1.0 build plan</div>
  <h1>Implementation Roadmap — FFI gate · Monomorphization · Capability model</h1>
  <p class="thesis">The ordered, dependency-driven plan for Silicon's three remaining workstreams. The hard
  v1.0 product gate is <b>100% web/bun FFI coverage</b>; the critical path runs
  <b>monomorphization substrate → closures → poll-reactor</b>. Each item is broken into subtasks with its ADR,
  key files, size, risk, and what it unblocks.</p>
  <div class="meta">Generated <b>{GEN_DATE}</b> · derived from ADRs 0001/0003/0008/0009/0011/0012/0013/0015/0016/0017/0018/0019 ·
  cross-checked against <code>docs/v1.0-critical-path.md</code></div>
  <div class="meta">Progress (2026-06-10): <b style="color:var(--mono)">Phases 0–3 ✓ — the v1.0 FFI gate is CLOSED and the poll-reactor is complete.</b>
  C0/M0/F0a; F1a object handles; F1b blocking <code>@await</code> productized (dual-backend, JSPI + Asyncify); C1 closures + C2
  (escape gate AND host-callable closures, leak-free under <code>--target=wasm-gc</code>, Bun round-trip verified); <b>F3 poll-reactor
  done</b> — generic <code>Poll[T]</code>, spawn/task-drain, and a guest <code>Future</code>↔host <code>Promise</code> bridge woken by the reactor
  (<code>future_async.si</code>). <b>Capability model (K1–K8) not started — by design (post-v1.0); M1 container mono is v1.1.</b>
  <b>Beyond the gate</b>, the FFI <i>surface</i> was broadened end-to-end (see “Post-gate FFI surface” below): object/array reflection,
  host-error→<code>Result</code>, streaming, concurrency, the fetch ecosystem, bulk binary, Node <code>fs</code>, first-class <code>fetch</code>.</div>
  <div class="tiles">
    <div class="tile"><div class="num">{n_total}</div><div class="lbl">subtasks</div></div>
    <div class="tile gate"><div class="num">{n_crit}</div><div class="lbl">on the critical path</div></div>
    <div class="tile v10"><div class="num">{n_v10}</div><div class="lbl">v1.0 gate items</div></div>
    <div class="tile done"><div class="num">{n_done}</div><div class="lbl">shipped (done)</div></div>
    <div class="tile"><div class="num">3</div><div class="lbl">workstreams · 12 ADRs</div></div>
  </div>
  <div class="legend">{legend}</div>
</div></header>

<nav class="toc"><div class="wrap">
  <a href="#timeline">Critical-path timeline</a>
  <a href="#item-ffi">FFI gate</a>
  <a href="#item-mono">Monomorphization</a>
  <a href="#item-cap">Capability model</a>
  <a href="#surface">Post-gate FFI surface</a>
  <a href="#tensions">Sequencing notes</a>
</div></nav>

<div class="wrap">

  <section id="timeline">
    <h2 class="sec" style="border-top:none">Critical-path timeline</h2>
    <p class="blurb">Dependency-driven order. Within a phase, items run in parallel; across phases, later items
    depend on earlier. The async spine (<code>F1a → F1b</code>, →80%) and the closure spine
    (<code>M0 → C0 → C1 → C2</code>, →97%) converge at the poll-reactor.</p>
    <div class="ladder">{ladder}</div>
    <div class="critline"><b>Longest chain to the gate (all ✓):</b>
      <code>M0</code> → <code>C0</code> → <code>C1</code> → <code>C2</code> (gate, ~97%) → <code>F3</code> (100%, poll-reactor complete).
      <code>F0a</code> (bindgen) and the capability model (<code>K1…K8</code>) are off the critical path.</div>
  </section>

  {item_table("ffi", "Item A — FFI gate", "The hard v1.0 product gate: lift web/bun coverage from ~10% to 100%. Bindgen, object handles, and Asyncify <code>@await</code> reach ~80% <i>without</i> monomorphization; the closures keystone (C0→C1→C2) needs it, and C2 closes the gate. ADR 0017 → 0018 → 0019.", ["F0a","F1a","F1b","C0","C1","C2","F3","F3-opt"])}

  {item_table("mono", "Item B — Monomorphization", "<code>@fn[T]</code> and <code>@type[T]</code> (Option/Result) already ship. What remains: the comptime-specialization <b>substrate</b> (pulled into v1.0 because closures C1 consume it) and the <b>container</b> application (Vec[T]/HashMap[K,V], v1.1). ADR 0001 (substrate via ADR 0003 C-1).", ["M0","M1"])}

  {item_table("cap", "Item C — Capability model", "All zero-code today (the P0 comptime substrate shipped). The <code>on::check</code> + reflection substrate gates everything. <b>Deliberately decoupled from the v1.0 FFI gate</b> — v1.0 closures use by-value/immutable capture, which needs no borrow checker. ADR 0011/0012/0013/0015.", ["K1","K2","K3","K4","K5","K6","K7","K8"])}

  <section id="surface" class="prose">
    <h2 class="sec"><span class="dot ffi"></span>Post-gate FFI surface — broadening the actual API reach</h2>
    <p class="blurb">The roadmap above is the <b>mechanism</b> gate (can every host-interaction <i>shape</i> be expressed). Once
    C2 closed it, the work shifted to the FFI <b>surface</b> — making the bound APIs genuinely callable and shipping
    more of them. All of the below landed on <code>v1-roadmap</code> (2026-06-10), each tested; not roadmap items, but
    the payoff of the gate.</p>
    <table class="rt">
    <thead><tr><th>#</th><th>Surface work</th><th>What it delivers</th><th>Status</th></tr></thead>
    <tbody>
    <tr class="t-ffi status-done"><td class="cid"><span class="idbadge ffi">N1</span></td>
      <td class="ctitle"><div class="tt">Generic object/array build-and-read</div>
      <div class="tdesc">The <code>js</code> module: build options-bag objects/arrays in-guest (<code>js::object</code>/<code>array</code>/<code>set</code>/<code>push</code>/<code>from_*</code>) and inspect handles handed back (<code>get</code>/<code>len</code>/<code>keys</code>/<code>typeof</code>/<code>as_*</code>). Closes the options-bag-in + inspection-out gaps that left most <code>JSValue</code>-returning APIs uncallable.</div></td>
      <td class="cadr">next FFI #1</td><td class="cmeta"><span class="st st-done">✓ DONE</span></td></tr>
    <tr class="t-ffi status-done"><td class="cid"><span class="idbadge ffi">N2</span></td>
      <td class="ctitle"><div class="tt">Host-error / Promise-rejection → <code>Result</code></div>
      <div class="tdesc">The <code>@try</code>-at-the-boundary bridge: <code>js::call</code>/<code>apply</code>/<code>construct</code> catch a host throw into a boundary slot (no trap); the reactor captures a Promise rejection the same way; stdlib <code>ffi.si</code> (<code>js_check</code>/<code>js_try</code>) lifts it into <code>Result[Int, String]</code>.</div></td>
      <td class="cadr">next FFI #2</td><td class="cmeta"><span class="st st-done">✓ DONE</span></td></tr>
    <tr class="t-ffi status-done"><td class="cid"><span class="idbadge ffi">N3</span></td>
      <td class="ctitle"><div class="tt">Async iteration / streaming</div>
      <div class="tdesc">The <code>stream</code> module: <code>iter</code>/<code>next</code>/<code>value</code>/<code>done</code> over any host iterable (array/Set/Map/generator/string), and <code>aiter</code>/<code>anext</code> (<code>@suspending</code>) over async generators / ReadableStream via the reactor.</div></td>
      <td class="cadr">next FFI #3</td><td class="cmeta"><span class="st st-done">✓ DONE</span></td></tr>
    <tr class="t-ffi status-done"><td class="cid"><span class="idbadge ffi">N4</span></td>
      <td class="ctitle"><div class="tt">True concurrency over host I/O</div>
      <div class="tdesc">The <code>promise</code> module: <code>all</code>/<code>race</code>/<code>all_settled</code>/<code>any</code>/<code>value</code> (<code>@suspending</code>). Kick off N host ops un-awaited, join with one <code>@await</code>. <b>Folds back into F3</b> as the host-delegated concurrency path.</div></td>
      <td class="cadr">next FFI #4</td><td class="cmeta"><span class="st st-done">✓ DONE</span></td></tr>
    <tr class="t-ffi status-done"><td class="cid"><span class="idbadge ffi">N5</span></td>
      <td class="ctitle"><div class="tt">Generator harvest — overload selection + fetch ecosystem</div>
      <div class="tdesc">dts best-bindable overload selection (recovered Bun.spawn/write/file); webiface <code>@suspending</code> (Response.json/text awaitable); shipped <code>response</code>/<code>request</code>/<code>blob</code>/<code>form_data</code>/<code>abort_controller</code>/<code>abort_signal</code> + <code>crypto</code> (+92 bindings).</div></td>
      <td class="cadr">next FFI #5</td><td class="cmeta"><span class="st st-done">✓ DONE</span></td></tr>
    <tr class="t-mono status-done"><td class="cid"><span class="idbadge mono">F1</span></td>
      <td class="ctitle"><div class="tt"><code>Result</code> can carry a host handle</div>
      <div class="tdesc"><code>js_try(JSValue) -> Result[Int, String]</code> (pins the handle) shipped. The NATIVE form (<code>Result[JSValue, …]</code>, no pin) is <b>deferred to M0-style monomorphization</b> — generic sums share one struct, so per-field ref typing falls out of monomorphizing them.</div></td>
      <td class="cadr">follow-up #1</td><td class="cmeta"><span class="st st-partial">◐ PARTIAL · → M1</span></td></tr>
    <tr class="t-ffi status-done"><td class="cid"><span class="idbadge ffi">F2</span></td>
      <td class="ctitle"><div class="tt">Bulk binary marshalling</div>
      <div class="tdesc"><code>js::bytes_in</code>/<code>bytes_out</code>/<code>byte_length</code>/<code>u8</code> — bulk-copy between guest linear memory and a host typed array (crypto bytes, <code>response.arrayBuffer</code>, file reads), instead of byte-by-byte.</div></td>
      <td class="cadr">follow-up #2</td><td class="cmeta"><span class="st st-done">✓ DONE</span></td></tr>
    <tr class="t-ffi status-done"><td class="cid"><span class="idbadge ffi">F3s</span></td>
      <td class="ctitle"><div class="tt">dts mixed-union → Node <code>fs</code></div>
      <div class="tdesc">Fixed the union classifier (mixed <code>string | Buffer | URL</code> → String/JSValue) → unlocked <code>fs</code> (49 bindings) + ~19 crypto primitives; also fixed a latent dropped-optional positional bug.</div></td>
      <td class="cadr">follow-up #3</td><td class="cmeta"><span class="st st-done">✓ DONE</span></td></tr>
    <tr class="t-ffi status-done"><td class="cid"><span class="idbadge ffi">F4</span></td>
      <td class="ctitle"><div class="tt">Bare-global harvest — first-class <code>fetch</code></div>
      <div class="tdesc">A bare-global dts mode → the <code>global</code> module: <code>global::fetch</code> (<code>@suspending</code>, Promise&lt;Response&gt;), <code>atob</code>/<code>btoa</code>, <code>queue_microtask</code>. <code>fetch</code> is now first-class, not a <code>js::global</code>+<code>apply</code> composition.</div></td>
      <td class="cadr">follow-up #4</td><td class="cmeta"><span class="st st-done">✓ DONE</span></td></tr>
    </tbody></table>
    <p class="blurb">Also this period: <code>@match</code> moved to the flat function-call form (<code>@match(x, $A v, {{ v }}, …)</code>),
    dropping the infix <code>=&gt;</code> arm operator that collided with flat operator precedence.</p>
  </section>

  <section id="tensions">
    <h2 class="sec">Sequencing notes — the three couplings that set the order</h2>
    <div class="callout">
      <h4>1 · Monomorphization ↔ closures (the join)</h4>
      <ul><li><b>M0 is a v1.0 item, not v1.1.</b> Closures C1 specialize the captured-env type per concrete shape using
      <i>exactly</i> the ADR-0001 comptime monomorphization machinery. So the substrate (M0) must land before C1 — even though
      the container payoff (M1: Vec[T]/HashMap) is v1.1. The ADR-0016 combinators (<code>vec_map[T,U](v, cb)</code>) are the
      join of M1 + C1: they need container mono <i>and</i> closures.</li></ul>
    </div>
    <div class="callout">
      <h4>2 · FFI ↔ closures (the keystone)</h4>
      <ul><li>Bindgen + object handles + Asyncify <code>@await</code> reach ~80% with no closures. But callbacks/events
      (~80→97%) and the poll-reactor (~97→100%) <i>are</i> closures — which is why ADR 0018 pulls them forward as a v1.0
      keystone. <b>C2 (escaping, wasm-gc-only) is the highest-risk single item and the point the gate closes.</b>
      It needs wasm-gc (present in Bun/JSC), not JSPI (absent) — independent of the async mechanism.</li></ul>
    </div>
    <div class="callout">
      <h4>3 · Capability model ↔ v1.0 (the decoupling)</h4>
      <ul><li>The capability model is <b>off the v1.0 critical path</b>. ADR 0019 v1.0 closures restrict to by-value/
      immutable capture precisely so they need <i>no</i> borrow checker. Within the capability track the order is strict
      (<code>K1 on::check</code> → <code>K2 reflection</code> → checker/ocaps → optimizer), and the borrow checker
      (<code>K8</code>, ADR 0011) is explicitly <b>“extremely low priority” (v1.y)</b> — its payoff is unlocking
      <i>mutable</i> capture in escaping closures and data-race-free concurrency.</li></ul>
    </div>
  </section>
</div>

<footer><div class="wrap" style="padding-bottom:0">
  Silicon implementation roadmap · {n_total} subtasks across 3 workstreams · generated {GEN_DATE}.
  Re-run <code>scripts/gen_roadmap_html.py</code> after an ADR is accepted or a phase lands.
  Source of truth: <code>docs/adr/</code> + <code>docs/v1.0-critical-path.md</code>.
</div></footer>
</body>
</html>"""

open(OUT, "w").write(HTML)
print(f"wrote {OUT} ({len(HTML)} bytes, {n_total} subtasks, {n_crit} on critical path)")
