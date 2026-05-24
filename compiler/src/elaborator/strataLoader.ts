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
  type Elaboration,
} from '../ast/astNodes'
import {
  createElaboratorRegistry,
  registerElaborator,
  registerAnnotation,
  registerTypedOperator,
  registerTypedKeyword,
  registerDefExpander,
  registerPhaseHandler,
  registerComptimeHandler,
  registerModuleFinalizeHandler,
  registerStratumMeta,
  type ElaboratorRegistry,
  type StratumTier,
  type StratumMeta,
} from './registry'
import { StrataType, type StrataNode, type StrataData, strataTypeFromIntrinsic } from './strataenum'
import { intrinsicSignature } from '../types/intrinsicSig'
import { registerDefKind, type CodegenKind } from './defkinds'
import { getIRKind } from '../ir/irKinds'
import { loadBuiltinStrata } from '../strata/index'
import { builtinDefExpanders } from '../strata/defExpanders'
import { isRichBody, compileBodyToDefExpander, compileBodyToExpanderFn, compileHandlerBlock, compileComptimeHandler } from './strataBody'
import { registerBuiltinComptimeHandlers } from './comptimeBuiltins'
// D-E-1: comptime engine for pre-compiling strata handlers @fns at
// strata-load time.  See `compileStrataHandlers` call in buildStrataRegistry.
import { compileStrataHandlers } from '../comptime/engine'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

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

  // Register the built-in comptime handlers FIRST so any subsequent stratum
  // can read or override them.  These define the compile-time semantics of
  // @nil, @not, ==, !=, +, -, *, /, %, <, >, <=, >= — used by the strata
  // body interpreter.  Authoring them as data (rather than hardcoding them
  // in the interpreter) is what lets user strata extend or override these
  // forms in the same way they extend runtime forms.
  registerBuiltinComptimeHandlers(registry)

  // T0: built-in strata from .si files.  Process both legacy Elaboration
  // (`@stratum_keyword`/`@stratum_operator`) and the new unified `@stratum`
  // form so future migrations of builtin strata can mix the two while the
  // dissolution moves forward incrementally.
  for (const elab of parseBuiltinStrata()) {
    registerElaboration(registry, elab, 'T0')
  }
  // Also walk builtin sources as a Program AST to pick up @stratum
  // unified-form Definitions and top-level @fn handler bodies — same
  // shape as the T1 pre-pass.  Per-file failures here are tolerated:
  // if a builtin source doesn't parse cleanly as a full program (some
  // legacy-only files won't), we keep going with the Elaboration-only
  // processing above.
  const builtinProg = parseStrataSourceAsProgram(loadBuiltinStrata())
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

  // T2: external strata files supplied by the caller.
  for (const source of extraSources) {
    for (const elab of parseStrataSource(source)) {
      registerElaboration(registry, elab, 'T2')
    }
    // Also process @stratum unified-form definitions AND top-level @fn
    // handler bodies — same shape as the T0/T1 pre-passes.  Without the
    // @fn capture, on::* references to extraSource-defined handlers
    // can't resolve at fire time.
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
    let elab: Elaboration | undefined
    if (element.type === 'Elaboration') {
      elab = element as Elaboration
    } else if (element.type === 'Element' && element.kind === 'elaboration') {
      elab = element.value as Elaboration
    }
    if (elab) {
      registerElaboration(registry, elab, 'T1')
      continue
    }
    // @stratum unified form — Definition keyword '@stratum'.
    const def = unwrapToDefinition(element)
    if (def?.keyword === '@stratum') {
      registerStratumDefinition(registry, def, 'T1')
    }
  }

  // T0 cycle detection (T-6): verify T0 reference graph is a DAG.
  detectT0Cycles(registry)

  // Apply @@before / @@after ordering to per-phase handler lists (§4 Layer 4).
  applyHandlerOrdering(registry)

  // Phase D: register built-in definition expanders (definition-kind lowering hooks).
  // Only registers if a strata rich body hasn't already claimed the codegen kind —
  // rich bodies win so users can override built-in behaviour from Silicon.
  for (const [codegenKind, exp] of Object.entries(builtinDefExpanders)) {
    if (!registry.defExpanders.has(codegenKind)) {
      registerDefExpander(registry, codegenKind, exp)
    }
  }

  // D-E-1: pre-compile every claimed strata handler @fn so the
  // named-handler wrapper can rely on `registry.compiledHandlers` —
  // no interpreter fallback.  Static import — engine.ts loads via
  // top-level await on wabt (codegen/toWasm.ts), which is fine since
  // it's a one-time module-load cost.
  compileStrataHandlers({ type: 'Program', elements: [] } as any, registry)

  return registry
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Register a single Elaboration node into the registry. */
function registerElaboration(registry: ElaboratorRegistry, elab: Elaboration, tier: StratumTier = 'T0'): void {
  const baseNode = elaborationToStrataNode(elab)
  const symbol = symbolToString(elab.symbol)
  const sig = baseNode.data?.typeSignature

  if (elab.kind === 'operator' && sig && sig.params.length > 0) {
    const typeKind = sig.params[0].kind  // 'Int', 'Float', 'Bool', etc.

    // Tag as Constraint when another variant of this symbol is already registered.
    const isConstraint = registry.operators[symbol] != null
    const node: StrataNode = isConstraint
      ? { ...baseNode, type: StrataType.Constraint }
      : baseNode

    // Store under compound typed key (e.g. '+:Float').
    registerTypedOperator(registry, symbol, typeKind, node)

    // Also set as the primary entry if this is the first registration for this symbol.
    if (!registry.operators[symbol]) {
      registerElaborator(registry, 'operator', symbol, baseNode)
    }
  } else if (elab.kind === 'keyword' && sig && sig.params.length > 0) {
    const typeKind = sig.params[0].kind  // 'Int', 'Float', etc.

    // Tag as Constraint when another variant of this keyword is already registered.
    const isConstraint = registry.keywords[symbol] != null
    const node: StrataNode = isConstraint
      ? { ...baseNode, type: StrataType.Constraint }
      : baseNode

    // Store under compound typed key (e.g. '@toFloat:Int').
    registerTypedKeyword(registry, symbol, typeKind, node)

    // Also set as the primary entry if this is the first registration for this keyword.
    if (!registry.keywords[symbol]) {
      registerElaborator(registry, 'keyword', symbol, baseNode)
    }
  } else {
    // No type constraint: plain registration (last-one-wins primary).
    registerElaborator(registry, elab.kind, symbol, baseNode)
  }

  const codegenKind = codegenKindFromIntrinsic(baseNode.data?.intrinsic)
  if (codegenKind) {
    registerDefKind(registry.defKinds, {
      keyword: symbol,
      codegenKind,
      allowsParams: codegenKind === 'function' || codegenKind === 'extern',
      allowsBinding: codegenKind !== 'extern' && codegenKind !== 'export',
      allowsGenerics: codegenKind === 'function',
    })
  }

  // Rich body: contains &Compiler:: calls or @local bindings.  Compile the
  // body into a closure and register it.  Definition-kind bodies override
  // the hardcoded TS def expander (if any); other bodies become an
  // IRExpanderFn keyed on the intrinsic.
  if (isRichBody(elab.semantics)) {
    const nodeParamName = elab.nodeParamName
    if (codegenKind) {
      registry.defExpanders.set(codegenKind, compileBodyToDefExpander(elab.semantics, nodeParamName))
    } else if (baseNode.data?.intrinsic) {
      registry.expanders.set(baseNode.data.intrinsic, compileBodyToExpanderFn(elab.semantics, nodeParamName))
    }
  }
}

/** Parse a Silicon source string and return all Elaboration nodes found. */
function parseStrataSource(source: string): Elaboration[] {
  const match = parse(source)
  const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
  return (ast.elements as any[]).filter(el => el.type === 'Elaboration') as Elaboration[]
}

/** Parse a Silicon source string and return the full Program AST. */
function parseStrataSourceAsProgram(source: string): Program | null {
  try {
    const match = parse(source)
    return addToAstSemantics(siliconGrammar)(match).toAst() as Program
  } catch {
    return null
  }
}

/** Built-in strata loaded from .si files in src/strata/. */
function parseBuiltinStrata(): Elaboration[] {
  return parseStrataSource(loadBuiltinStrata())
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
        env.handles.release(nodeId)
        env.irHandles.clear()
        env.ctx = undefined
        env.api = undefined
        return result ?? null
      }
      const entry = registry.namedHandlers.get(handlerName)
      if (!entry) {
        throw new Error(
          `[strata] named handler '${handlerName}' referenced by stratum '${stratumName}' ` +
          `but no top-level @fn ${handlerName} was found in the program`,
        )
      }
      const fn = compileHandlerBlock(entry.body, entry.paramName)
      return fn(node, api)
    }
    ;(wrapper as any).__stratumName = stratumName
    ;(wrapper as any).__handlerName = handlerName
    return wrapper
  }
  // Inline block — uses the strata-body interpreter directly.  Retained
  // for backward-compat with tests + the small number of inline
  // declarations.  Long-term: auto-extract to a synthetic @fn (similar
  // to the named-handler path) once `&Compiler::*` callers migrate to
  // `&compiler::*`.
  const handler = compileHandlerBlock(arg, 'node')
  ;(handler as any).__stratumName = stratumName
  return handler
}

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
      const entry = registry.namedHandlers.get(handlerName)
      if (!entry) {
        throw new Error(
          `[strata] named comptime handler '${handlerName}' referenced by stratum ` +
          `'${stratumName}' but no top-level @fn ${handlerName} was found in the program`,
        )
      }
      const fn = compileComptimeHandler(entry.body)
      return fn(rawArgs, api, evalArg)
    }
    ;(wrapper as any).__stratumName = stratumName
    return wrapper
  }
  const handler = compileComptimeHandler(arg)
  ;(handler as any).__stratumName = stratumName
  return handler
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

/** Normalize an Elaboration symbol to a plain string. */
function symbolToString(symbol: any): string {
  if (typeof symbol === 'string') return symbol
  if (symbol && symbol.type === 'StringLiteral') return symbol.value
  return String(symbol)
}

/** Map an IR::def_* or IR::meta_* intrinsic to the corresponding codegen kind. */
function codegenKindFromIntrinsic(intrinsic: string | undefined): CodegenKind | undefined {
  return getIRKind(intrinsic ?? '')?.codegenKind
}

/**
 * Convert an Elaboration AST node to a StrataNode.
 * Extracts the WASM intrinsic and body template from the body so downstream
 * phases (codegen, type checker) can use them without re-walking the AST.
 * The raw body AST is NOT stored — only the derived data is kept.
 */
function elaborationToStrataNode(elaboration: Elaboration): StrataNode {
  const intrinsic = extractIntrinsicFromBody(elaboration.semantics)
  const bodyTemplate = extractBodyTemplate(elaboration.semantics as any, elaboration.nodeParamName)
  const kind = elaboration.kind as 'operator' | 'keyword'
  const data: StrataData = {
    nodeParamName: elaboration.nodeParamName,
    intrinsic,
    bodyTemplate,
    typeSignature: intrinsic ? intrinsicSignature(intrinsic) : undefined,
  }
  return {
    type: strataTypeFromIntrinsic(intrinsic, kind),
    discriminant: symbolToString(elaboration.symbol),
    data,
  }
}

/**
 * Walk the strata body AST and extract ALL WASM function calls as an ordered
 * sequence of steps.  Each step captures the intrinsic name and which node
 * references (left / right) appear as explicit arguments.
 *
 * Steps with no argRefs implicitly consume the top of the WAT operand stack
 * (i.e. the result produced by the previous step).
 */
function extractBodyTemplate(
  body: any,
  nodeParamName: string
): StrataData['bodyTemplate'] {
  if (!body || !Array.isArray(body.items)) return undefined
  const steps: NonNullable<StrataData['bodyTemplate']> = []
  for (const item of body.items) {
    if (!item || typeof item !== 'object') continue
    const fc = findFunctionCall(item.value ?? item)
    if (!fc) continue

    const argRefs = (fc.args ?? []).map((arg: any): 'left' | 'right' | 'unknown' => {
      const ns = findNamespace(arg)
      if (!ns) return 'unknown'
      const nsStr = (ns.path as string[]).join('.')
      if (nsStr === `${nodeParamName}.left`) return 'left'
      if (nsStr === `${nodeParamName}.right`) return 'right'
      return 'unknown'
    })

    const name = fc.name
    if (!name) continue

    if (name.type === 'Namespace') {
      const path = name.path as string[]
      if (path[0] === 'WASM' || path[0] === 'IR') {
        // WASM/IR intrinsic — existing behaviour
        steps.push({ intrinsic: path.join('::'), argRefs })
      } else if (path.length === 1) {
        // Plain Silicon function call (e.g. &str_concat)
        steps.push({ userFunc: path[0], argRefs })
      }
    } else if (typeof name === 'string') {
      steps.push({ userFunc: name, argRefs })
    }
  }
  return steps.length > 0 ? steps : undefined
}

/** Walk an AST node tree looking for the first FunctionCall whose name is a WASM namespace. */
function extractIntrinsicFromBody(node: any): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = extractIntrinsicFromBody(child)
      if (r) return r
    }
    return undefined
  }
  if (node.type === 'FunctionCall') {
    const name = node.name
    if (name && Array.isArray(name.path) && (name.path[0] === 'WASM' || name.path[0] === 'IR')) {
      return name.path.join('::')
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'sourceLocation' || key === 'inferredType') continue
    const child = node[key]
    if (child && typeof child === 'object') {
      const r = extractIntrinsicFromBody(child)
      if (r) return r
    }
  }
  return undefined
}

function findFunctionCall(node: any): any {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'FunctionCall') return node
  for (const key of Object.keys(node)) {
    if (key === 'sourceLocation' || key === 'inferredType') continue
    const child = node[key]
    if (child && typeof child === 'object') {
      const r = findFunctionCall(child)
      if (r) return r
    }
  }
  return undefined
}

function findNamespace(node: any): any {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'Namespace') return node
  for (const key of Object.keys(node)) {
    if (key === 'sourceLocation' || key === 'inferredType') continue
    const child = node[key]
    if (child && typeof child === 'object') {
      const r = findNamespace(child)
      if (r) return r
    }
  }
  return undefined
}
