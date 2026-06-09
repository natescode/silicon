// SPDX-License-Identifier: MIT
/**
 * Strata Loader
 *
 * Responsible for building the ElaboratorRegistry from strata definitions.
 * This is a distinct phase from AST elaboration: the loader EVALUATES strata
 * (parses .si files, transforms Elaboration nodes into StrataNodes, registers
 * them) so the elaborator can consume the result as a plain data structure.
 *
 * Pipeline position: between AST construction and elaboration.
 *
 *   Parse → AST → buildStrataRegistry → elaborate(ast, registry) → TypeCheck → Codegen
 *
 * Keeping this separate from the elaborator means:
 * - The elaborator is a pure AST walker with no embedded mini-compiler.
 * - Future Strata phases (type-level, macro expansion) can be added here
 *   without touching the elaboration walk.
 */

import {
  type Program,
} from '../ast/astNodes'
import {
  createElaboratorRegistry,
  registerElaborator,
  registerAnnotation,
  registerDefExpander,
  registerPhaseHandler,
  registerComptimeHandler,
  registerModuleFinalizeHandler,
  registerStratumMeta,
  type ElaboratorRegistry,
  type StratumTier,
  type StratumMeta,
} from './registry'
import { StrataType, type StrataNode } from './strataenum'
import { registerDefKind } from './defkinds'
import { loadBuiltinStrata } from '../strata/index'
import { builtinDefExpanders } from '../strata/defExpanders'
import { translateLegacyBlock } from './legacyBlockTranslator'
// D-E-1: comptime engine for pre-compiling strata handlers @fns at
// strata-load time.  See `compileStrataHandlers` call in buildStrataRegistry.
import { compileStrataHandlers, compileHandlerToWasm } from '../comptime/engine'
import { drainModuleMutations } from '../comptime/imports'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

// ---------------------------------------------------------------------------
// Module-level T0 cache
// ---------------------------------------------------------------------------

// Cache the parsed built-in strata AST — it's 58KB of .si source that never
// changes between calls, so we pay the ~100ms parse cost only once per process.
let _cachedBuiltinProg: ReturnType<typeof parseStrataSourceAsProgram> | undefined | null = undefined

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an ElaboratorRegistry from all strata visible in the program.
 *
 * Four sources are processed in tier order (T0 → T1 → T2):
 *   T0  Built-in strata from .si files in src/strata/ (always first).
 *   T2  Extra strata sources — Silicon source strings from external strata
 *       files loaded by the caller (e.g. via the --strata CLI flag).
 *   T1  Inline user-defined @stratum / @stratum_operator / @stratum_keyword
 *       definitions found in the top-level elements of `ast`.
 *
 * After all strata are loaded, T0 strata are checked for reference cycles
 * (T-6). Detected cycles are broken deterministically and a diagnostic is
 * added to the registry.
 *
 * @param ast          The user's parsed program AST.
 * @param extraSources Optional Silicon source strings to mine for strata
 *                     definitions before processing the program AST.
 *                     Each string is the full contents of a strata .si file.
 */
export function buildStrataRegistry(
  ast: Program,
  extraSources: string[] = [],
): ElaboratorRegistry {
  const registry = createElaboratorRegistry()

  // D-E-3 PR 2: the registerBuiltinComptimeHandlers call is gone —
  // comptime handlers were only consumed by the strata-body interpreter
  // (strataBody.ts), which is being deleted in this PR.

  // D-E-3: register built-in def expanders FIRST so that any auto-extracted
  // inline-block handler (compiled on-demand during T2 processing of user
  // strata) has access to the `function` expander when its synthetic @fn
  // is lowered.  Order matters: T2 inline blocks → compileHandlerToWasm →
  // lowerDefinition('@fn') → defExpanders.get('function').
  for (const [codegenKind, exp] of Object.entries(builtinDefExpanders)) {
    if (!registry.defExpanders.has(codegenKind)) {
      registerDefExpander(registry, codegenKind, exp)
    }
  }

  // T0: built-in strata from .si files.  Walk the source as a Program
  // AST to pick up @stratum unified-form Definitions and top-level @fn
  // handler bodies — same shape as the T1 pre-pass.  Legacy
  // `@stratum_keyword` / `@stratum_operator` forms were retired in the
  // Phase 5 grammar revision; every built-in stratum uses the unified
  // form today.
  if (_cachedBuiltinProg === undefined) {
    _cachedBuiltinProg = parseStrataSourceAsProgram(loadBuiltinStrata())
  }
  const builtinProg = _cachedBuiltinProg
  if (builtinProg) {
    for (const el of (builtinProg.elements ?? []) as any[]) {
      const def = unwrapToDefinition(el)
      if (def?.keyword === '@stratum') {
        registerStratumDefinition(registry, def, 'T0')
      } else if (def?.keyword === '@fn' && def.name?.name && def.binding) {
        const binding = Array.isArray(def.binding) ? def.binding[0] : def.binding
        const body = binding?.expression ?? binding
        if (body) {
          const firstParam = (def.params ?? []).find((p: any) => !p.isLiteral && p.name)
          const paramName: string = firstParam?.name ?? 'node'
          registry.namedHandlers.set(def.name.name, { body, paramName })
        }
      }
    }
  }

  // T2: external strata files supplied by the caller.  Process
  // @stratum unified-form definitions AND top-level @fn handler bodies
  // — same shape as the T0/T1 pre-passes.  Without the @fn capture,
  // on::* references to extraSource-defined handlers can't resolve at
  // fire time.
  for (const source of extraSources) {
    const parsed = parseStrataSourceAsProgram(source)
    for (const el of (parsed?.elements ?? []) as any[]) {
      const def = unwrapToDefinition(el)
      if (def?.keyword === '@stratum') {
        registerStratumDefinition(registry, def, 'T2')
      } else if (def?.keyword === '@fn' && def.name?.name && def.binding) {
        const binding = Array.isArray(def.binding) ? def.binding[0] : def.binding
        const body = binding?.expression ?? binding
        if (body) {
          const firstParam = (def.params ?? []).find((p: any) => !p.isLiteral && p.name)
          const paramName: string = firstParam?.name ?? 'node'
          registry.namedHandlers.set(def.name.name, { body, paramName })
        }
      }
    }
  }

  // Dissolution Phase A pre-pass: collect every top-level `@fn` body keyed
  // by name so strata handlers registered by-name can find the body at
  // fire time, regardless of source order.  Done before strata registration
  // because @stratum bodies may reference @fn names that appear later in
  // the program.
  for (const element of ast.elements as any[]) {
    const def = unwrapToDefinition(element)
    if (def?.keyword === '@fn' && def.name?.name && def.binding) {
      const binding = Array.isArray(def.binding) ? def.binding[0] : def.binding
      const body = binding?.expression ?? binding
      if (body) {
        // First non-literal param becomes the body's `node` binding.  Falls
        // back to 'node' (the legacy interpreter convention) for @fns with
        // no params — those handlers can't read the AST but might still
        // run for side effects.
        const firstParam = (def.params ?? []).find((p: any) => !p.isLiteral && p.name)
        const paramName: string = firstParam?.name ?? 'node'
        registry.namedHandlers.set(def.name.name, { body, paramName })
      }
    }
  }

  // T1: inline user-defined strata from the program AST.
  for (const element of ast.elements as any[]) {
    // @stratum unified form — Definition keyword '@stratum'.  Legacy
    // Elaboration-based forms (`@stratum_operator` / `@stratum_keyword`)
    // were retired with the Phase 5 grammar revision.
    const def = unwrapToDefinition(element)
    if (def?.keyword === '@stratum') {
      registerStratumDefinition(registry, def, 'T1')
    }
  }

  // T0 cycle detection (T-6): verify T0 reference graph is a DAG.
  detectT0Cycles(registry)

  // Apply @@before / @@after ordering to per-phase handler lists (§4 Layer 4).
  applyHandlerOrdering(registry)

  // D-E-1: pre-compile every claimed strata handler @fn so the
  // named-handler wrapper can rely on `registry.compiledHandlers` —
  // no interpreter fallback.  Static import — engine.ts loads via
  // top-level await on wabt (codegen/toWasm.ts), which is fine since
  // it's a one-time module-load cost.
  // __t0Phase tells engine.ts to cache the compiled WebAssembly.Module
  // objects keyed by handler name — subsequent calls re-instantiate from
  // the cache (fast) instead of recompiling WAT → WASM from scratch.
  ;(registry as any).__t0Phase = true
  try {
    compileStrataHandlers({ type: 'Program', elements: [] } as any, registry)
  } finally {
    ;(registry as any).__t0Phase = false
  }

  return registry
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse a Silicon source string and return the full Program AST. */
function parseStrataSourceAsProgram(source: string): Program | null {
  try {
    const match = parse(source)
    return addToAstSemantics(siliconGrammar)(match).toAst() as Program
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// @stratum unified-form handler (Strata 2.0 §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unwrap an Element/Item/Statement wrapper to a Definition node, or null.
 * Also handles the flat (un-wrapped) shape from the ToAst semantics.
 */
function unwrapToDefinition(node: any): any | null {
  if (!node) return null
  if (node.type === 'Element') return unwrapToDefinition(node.value)
  if (node.type === 'Item')    return unwrapToDefinition(node.value)
  if (node.type === 'Statement') return unwrapToDefinition(node.value)
  if (node.type === 'Definition') return node
  return null
}

/**
 * Extract a string literal value from a parsed AST node.
 * Handles StringLiteral nodes and plain JS strings.
 */
function extractString(node: any): string | undefined {
  if (typeof node === 'string') return node
  if (node?.type === 'StringLiteral') return node.value
  if (node?.value && typeof node.value === 'string') return node.value
  return undefined
}

/**
 * Process a `@stratum Name := { body }` Definition node into the registry.
 *
 * The body is a Block whose items are FunctionCall statements:
 *   &Compiler::register::keyword '@token'
 *   &Compiler::register::operator '++'
 *   &Compiler::register::annotation '@@derive'
 *   &Compiler::on::lower '@token', { handler body }
 *   &Compiler::on::decl '@token', { handler body }
 *   &Compiler::on::call_site '@token', { handler body }
 *   &Compiler::on::annotation '@@token', { handler body }
 *   &Compiler::on::module_finalize { handler body }
 *   &Compiler::before 'OtherStrat'
 *   &Compiler::after 'OtherStrat'
 */
function registerStratumDefinition(
  registry: ElaboratorRegistry,
  def: any,
  tier: StratumTier,
): void {
  const name: string = def.name?.name ?? def.name ?? 'anonymous'
  const binding = def.binding
  const bodyExpr = binding?.expression ?? binding

  // Body must be a Block.
  const block = bodyExpr?.type === 'Block' ? bodyExpr : null
  if (!block) return

  const meta: StratumMeta = { name, tier, before: [], after: [] }

  // Walk Block items.
  const items: any[] = [...(block.items ?? []), ...(block.trailing ? [{ value: block.trailing }] : [])]

  for (const item of items) {
    const fc = findFunctionCallInItem(item)
    if (!fc) continue
    const path: string[] = fc.name?.path ?? []
    if (path[0] !== 'Compiler') continue

    const seg1 = path[1]
    const seg2 = path[2]
    const args: any[] = fc.args ?? []

    if (seg1 === 'register') {
      // register::keyword / register::operator / register::annotation
      const token = extractString(args[0])
      if (!token) continue

      // Create a minimal StrataNode stub so the token appears in the registry.
      const stub: StrataNode = {
        type: StrataType.Keyword,
        discriminant: token,
        data: { nodeParamName: 'node' },
      }
      if (seg2 === 'keyword') {
        registerElaborator(registry, 'keyword', token, stub)
        // Also register a def-kind so the keyword is valid as a def-keyword.
        // The codegenKind 'stratum_def' is handled in lowerDefinition via on::lower
        // handlers; if none are registered, the def produces no WAT output (T-5).
        registerDefKind(registry.defKinds, {
          keyword: token,
          codegenKind: 'stratum_def',
          allowsParams: true,
          allowsBinding: true,
          allowsGenerics: true,
        })
      } else if (seg2 === 'expression_keyword') {
        // Variant for expression-position keywords (`@if`, `@loop`, `@match`,
        // `@return`, …).  Registers the elaborator entry but NOT a def-kind,
        // so the keyword can't accidentally be used as a definition.
        registerElaborator(registry, 'keyword', token, stub)
      } else if (seg2 === 'operator')  { registerElaborator(registry, 'operator', token, stub) }
      else if (seg2 === 'typed_operator') {
        // `register::typed_operator '+', 'Float'` — registers an overload
        // for the operator under the compound key `${symbol}:${typeKind}`.
        // Used by D-D-7c to migrate the f32 / i64 operator variants.
        const typeKind = extractString(args[1])
        if (!typeKind) continue
        const compoundKey = `${token}:${typeKind}`
        registry.operators[compoundKey] = stub
      } else if (seg2 === 'typed_keyword') {
        // `register::typed_keyword '@toInt', 'Int64'` — keyword analog of
        // typed_operator.  Used by D-D-5's ToIntFromInt64 migration.
        const typeKind = extractString(args[1])
        if (!typeKind) continue
        const compoundKey = `${token}:${typeKind}`
        registry.keywords[compoundKey] = stub
      } else if (seg2 === 'annotation') { registerAnnotation(registry, token, stub) }

    } else if (seg1 === 'on') {
      // on::decl / on::call_site / on::annotation / on::lower / on::module_finalize
      const phase = seg2

      if (phase === 'module_finalize') {
        const arg = args[0]
        if (arg) {
          const handler = buildPhaseHandler(arg, registry, name)
          if (handler) registerModuleFinalizeHandler(registry, handler)
        }
      } else {
        const token = extractString(args[0])
        // When the first arg is the handler block / handler ref (no string
        // token), register under the wildcard key '*' for call_site so the
        // handler fires on every call.  Other phases without a token fall
        // back to the stratum name (legacy behavior).
        const handlerArg = token ? args[1] : args[0]
        if (!handlerArg) continue

        // Comptime handlers take a different shape — eager-evaluated args
        // bound as arg0/arg1/... in the body's scope.  Compile separately.
        if (phase === 'comptime') {
          if (!token) continue   // comptime requires an operator/keyword token
          const handler = buildComptimeHandler(handlerArg, registry, name)
          if (handler) registerComptimeHandler(registry, token, handler)
          continue
        }

        const handler = buildPhaseHandler(handlerArg, registry, name)
        if (!handler) continue

        if (phase === 'decl')       registerPhaseHandler(registry, 'decl', token ?? name, handler)
        else if (phase === 'call_site') registerPhaseHandler(registry, 'callSite', token ?? '*', handler)
        else if (phase === 'annotation') registerPhaseHandler(registry, 'annotation', token ?? name, handler)
        else if (phase === 'lower') registerPhaseHandler(registry, 'lower', token ?? name, handler)
      }

    } else if (seg1 === 'before') {
      const target = extractString(args[0])
      if (target) meta.before.push(target)

    } else if (seg1 === 'after') {
      const target = extractString(args[0])
      if (target) meta.after.push(target)
    }
  }

  registerStratumMeta(registry, meta)
}

/** Find the first FunctionCall node in an Item/Statement/Element wrapper. */
/**
 * Build a PhaseHandler from a strata `on::*` argument.
 *
 * Two shapes are accepted:
 *   - **Block** (legacy / inline) — compiled directly via compileHandlerBlock.
 *     The body sees the triggering AST as the binding `node`.
 *   - **Namespace** (Phase A — named handler reference) — extracts the fn
 *     name, returns a wrapper that looks up the body in
 *     `registry.namedHandlers` at fire time and invokes it via the existing
 *     interpreter.  Lookup is lazy so forward references work.
 *
 * Returns null if the arg shape isn't recognised.  __stratumName is stamped
 * so per-stratum state buckets resolve correctly during firing.
 */
function buildPhaseHandler(
  arg: any,
  registry: ElaboratorRegistry,
  stratumName: string,
): ((node: any, api: any) => any) | null {
  if (!arg) return null
  // Namespace = named-handler reference (e.g. `&Compiler::on::decl '@t', MyHandler`).
  if (arg.type === 'Namespace' && Array.isArray(arg.path) && arg.path.length === 1) {
    const handlerName = arg.path[0]
    // Claim the @fn name: lowerProgram skips claimed names so their
    // `&Compiler::*` calls don't get treated as runtime WASM calls.
    registry.strataHandlerFnNames.add(handlerName)
    const wrapper = (node: any, api: any): any => {
      // D-E-1: prefer the compiled WASM instance (pre-built in
      // buildStrataRegistry's compileStrataHandlers pass).  Falls back to
      // compileHandlerBlock — kept for backward-compat with tests that
      // use the legacy `&Compiler::*` interpreter API in inline blocks.
      // Full retirement requires updating those tests to use `&compiler::*`.
      const compiled = registry.compiledHandlers.get(handlerName)
      if (compiled) {
        const env = compiled.env
        // Snapshot per-firing state so recursive firings don't trample.
        const prevCtx = env.ctx
        const prevApi = env.api
        env.ctx = api?.ctx
        env.api = api
        const nodeId = env.handles.intern(node)
        const resultId = compiled.invoke(nodeId)
        let result: any = resultId === 0 ? null : env.irHandles.get(resultId)
        // If the result is an array of handle ids (e.g. handlers that
        // emit multiple IR globals/functions like @type_sum), resolve
        // each id to its underlying IR object so lowerProgram's append
        // can route them.
        if (Array.isArray(result)) {
          result = result.map((v) => typeof v === 'number' ? env.irHandles.get(v) : v).filter(Boolean)
        }
        drainModuleMutations(env, registry)
        env.handles.release(nodeId)
        // Note: do NOT clear env.irHandles — recursive firings share the
        // env and would lose each other's handles mid-flight.  The
        // process-wide growth is bounded by the number of IR nodes built
        // during compilation; lifetime ends with the process.
        env.ctx = prevCtx
        env.api = prevApi
        return result ?? null
      }
      // D-E-3 PR 2: no fallback.  Every named handler must be in
      // registry.compiledHandlers (populated by buildStrataRegistry's
      // pre-compile pass).  Reaching here means the handler @fn body
      // either failed to compile or was never registered.
      throw new Error(
        `[strata] named handler '${handlerName}' (referenced by stratum '${stratumName}') ` +
        `has no compiled instance — did the @fn body fail to compile?`,
      )
    }
    ;(wrapper as any).__stratumName = stratumName
    ;(wrapper as any).__handlerName = handlerName
    return wrapper
  }
  // Inline block — D-E-3 PR 1: auto-extract to a synthetic @fn via
  // legacyBlockTranslator, compile through the Phase C engine, and
  // dispatch via the same compiled-handler wrapper as named handlers.
  // No interpreter call at fire time.
  return makeAutoExtractedHandler(arg, registry, stratumName, 'phase')
}

/**
 * Auto-extract an inline-block handler body into a synthetic top-level
 * `@fn`, compile it through the comptime engine, and return a wrapper
 * that dispatches to the compiled instance.  Used by buildPhaseHandler
 * and buildComptimeHandler for the inline-block case.
 *
 * The `kind` parameter selects the wrapper shape:
 *   'phase'    → (node, api) → IR
 *   'comptime' → (rawArgs, api, evalArg) → value
 */
function makeAutoExtractedHandler(
  block: any,
  registry: ElaboratorRegistry,
  stratumName: string,
  kind: 'phase' | 'comptime',
): any {
  const paramName = kind === 'comptime' ? '__rawArgs' : 'node'
  // Translate the legacy &Compiler::* AST to the new &compiler::* form.
  const translatedBody = translateLegacyBlock(block, paramName)
  const synthName = `__inline_${kind}_handler_${_inlineHandlerCounter++}`
  registry.namedHandlers.set(synthName, { body: translatedBody, paramName })
  registry.strataHandlerFnNames.add(synthName)

  // Eagerly compile so the wrapper can dispatch via the compiled
  // instance at fire time.  Uses the same engine as buildStrataRegistry's
  // pre-compile pass (sync; wabt pre-init'd via top-level await).
  try {
    const compiled = compileHandlerToWasm(synthName, { type: 'Program', elements: [] } as any, registry)
    registry.compiledHandlers.set(synthName, compiled)
  } catch (e) {
    throw new Error(
      `[strata] inline handler in stratum '${stratumName}' failed to compile via auto-extract: ${(e as Error).message}`,
    )
  }

  if (kind === 'phase') {
    const wrapper = (node: any, api: any): any => {
      const compiled = registry.compiledHandlers.get(synthName)!
      const env = compiled.env
      const prevCtx = env.ctx
      const prevApi = env.api
      env.ctx = api?.ctx
      env.api = api
      const nodeId = env.handles.intern(node)
      const resultId = compiled.invoke(nodeId)
      let result: any = resultId === 0 ? null : env.irHandles.get(resultId)
      if (Array.isArray(result)) {
        result = result.map((v) => typeof v === 'number' ? env.irHandles.get(v) : v).filter(Boolean)
      }
      drainModuleMutations(env, registry)
      env.handles.release(nodeId)
      env.ctx = prevCtx
      env.api = prevApi
      return result ?? null
    }
    ;(wrapper as any).__stratumName = stratumName
    ;(wrapper as any).__handlerName = synthName
    return wrapper
  }

  // 'comptime' kind: receives (rawArgs, api, evalArg).  The synthetic
  // handler's @fn body sees `__rawArgs` as its node-param.  Args are
  // eagerly evaluated by evalArg before firing.
  const wrapper = (rawArgs: any[], api: any, evalArg: (n: any) => any): any => {
    const compiled = registry.compiledHandlers.get(synthName)!
    const env = compiled.env
    const prevCtx = env.ctx
    const prevApi = env.api
    env.ctx = api?.ctx
    env.api = api
    // Evaluate args via the supplied evaluator (matches legacy comptime
    // semantics — args are values, not handles).
    const evaluated = rawArgs.map(evalArg)
    const nodeId = env.handles.intern(evaluated)
    const resultId = compiled.invoke(nodeId)
    const result = resultId === 0 ? null : env.irHandles.get(resultId)
    env.handles.release(nodeId)
    env.ctx = prevCtx
    env.api = prevApi
    return result
  }
  ;(wrapper as any).__stratumName = stratumName
  ;(wrapper as any).__handlerName = synthName
  return wrapper
}

/** Monotonic counter for synthetic auto-extracted handler names. */
let _inlineHandlerCounter = 0

/** Comptime variant of buildPhaseHandler — same Block-vs-Namespace dispatch
 *  but with the comptime handler signature (rawArgs, api, evalArg). */
function buildComptimeHandler(
  arg: any,
  registry: ElaboratorRegistry,
  stratumName: string,
): ((rawArgs: any[], api: any, evalArg: (n: any) => any) => any) | null {
  if (!arg) return null
  if (arg.type === 'Namespace' && Array.isArray(arg.path) && arg.path.length === 1) {
    const handlerName = arg.path[0]
    registry.strataHandlerFnNames.add(handlerName)
    const wrapper = (rawArgs: any[], api: any, evalArg: (n: any) => any): any => {
      // D-E-3 PR 2: named comptime handlers must be pre-compiled.
      const compiled = registry.compiledHandlers.get(handlerName)
      if (!compiled) {
        throw new Error(
          `[strata] named comptime handler '${handlerName}' (stratum '${stratumName}') ` +
          `has no compiled instance — did the @fn body fail to compile?`,
        )
      }
      const env = compiled.env
      const prevCtx = env.ctx, prevApi = env.api
      env.ctx = api?.ctx
      env.api = api
      const evaluated = rawArgs.map(evalArg)
      const nodeId = env.handles.intern(evaluated)
      const resultId = compiled.invoke(nodeId)
      const result = resultId === 0 ? null : env.irHandles.get(resultId)
      env.handles.release(nodeId)
      env.ctx = prevCtx
      env.api = prevApi
      return result
    }
    ;(wrapper as any).__stratumName = stratumName
    ;(wrapper as any).__handlerName = handlerName
    return wrapper
  }
  // Inline comptime block — D-E-3 PR 1: auto-extract via translator.
  return makeAutoExtractedHandler(arg, registry, stratumName, 'comptime')
}

function findFunctionCallInItem(item: any): any {
  if (!item) return null
  if (item.type === 'FunctionCall') return item
  const inner = item.value ?? item.expression ?? item.body
  if (inner) return findFunctionCallInItem(inner)
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// T-6 Cycle detection (T0 strata only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that T0 strata form a DAG with respect to before/after ordering.
 * On detecting a cycle: break the lexicographically-earliest edge (by stratum
 * name pair), emit a diagnostic, and continue.
 */
function detectT0Cycles(registry: ElaboratorRegistry): void {
  const t0 = Array.from(registry.strata.values()).filter(m => m.tier === 'T0')
  if (t0.length < 2) return

  // Build adjacency list: A "before B" means edge A → B.
  const adj = new Map<string, Set<string>>()
  for (const m of t0) {
    if (!adj.has(m.name)) adj.set(m.name, new Set())
    for (const b of m.before) adj.get(m.name)!.add(b)
    // "after B" means B → A, i.e. B before A.
    for (const a of m.after) {
      if (!adj.has(a)) adj.set(a, new Set())
      adj.get(a)!.add(m.name)
    }
  }

  // Kahn's algorithm — detect cycles.
  const inDegree = new Map<string, number>()
  for (const [src, dests] of adj) {
    if (!inDegree.has(src)) inDegree.set(src, 0)
    for (const d of dests) inDegree.set(d, (inDegree.get(d) ?? 0) + 1)
  }

  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n).sort()
  const visited = new Set<string>()
  while (queue.length > 0) {
    const node = queue.shift()!
    visited.add(node)
    for (const neighbor of Array.from(adj.get(node) ?? []).sort()) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) queue.push(neighbor)
    }
    queue.sort()
  }

  // Any unvisited node is part of a cycle.
  const cycleNodes = t0.map(m => m.name).filter(n => !visited.has(n)).sort()
  if (cycleNodes.length > 0) {
    // Break the lexicographically-first edge in the cycle.
    const first = cycleNodes[0]
    const meta = registry.strata.get(first)
    if (meta) {
      const brokenTarget = meta.before.sort()[0] ?? meta.after.sort()[0]
      registry.diagnostics.push({
        phase: 'elaborate',
        code: 'S0001',
        span: { file: '', line: 0, col: 0, length: 0 },
        message: `Strata cycle detected in T0: broken edge ${first} → ${brokenTarget}`,
        hint: 'Reorder strata before/after declarations to remove the cycle.',
      })
      // Remove the broken edge.
      if (meta.before.includes(brokenTarget)) {
        meta.before = meta.before.filter(b => b !== brokenTarget)
      } else {
        meta.after = meta.after.filter(a => a !== brokenTarget)
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// @@before / @@after handler ordering (§4 Layer 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sort phase handler lists according to before/after stratum metadata.
 * Handlers are stable-sorted: registration order (tier ASC → source order)
 * is the default, then before/after constraints are applied as a topological
 * sort by stratum name prefix matching.
 *
 * This is a best-effort approximation: because handlers are compiled closures
 * we can't directly link a handler to its stratum name. In the future,
 * handlers should carry their stratum name as metadata. For now, the
 * registration-order invariant (T0 before T1 before T2) already satisfies
 * the most common ordering requirements.
 */
function applyHandlerOrdering(_registry: ElaboratorRegistry): void {
    // Registration order (T0 → T1 → T2) is the natural tier order mandated
    // by §3. Explicit before/after are handled by the strata author registering
    // in the correct order within their tier. Full topological sort across
    // closures requires handler tagging — deferred to a future revision.
}

