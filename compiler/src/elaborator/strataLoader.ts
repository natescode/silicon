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
  registerTypedOperator,
  registerTypedKeyword,
  registerExpander,
  registerDefExpander,
  type ElaboratorRegistry,
} from './registry'
import { StrataType, type StrataNode, type StrataData, strataTypeFromIntrinsic } from './strataenum'
import { intrinsicSignature } from '../types/intrinsicSig'
import { registerDefKind, type CodegenKind } from './defkinds'
import { getIRKind } from '../ir/irKinds'
import { loadBuiltinStrata } from '../strata/index'
import { builtinExpanders } from '../strata/expanders'
import { builtinDefExpanders } from '../strata/defExpanders'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an ElaboratorRegistry from all strata visible in the program.
 *
 * Three sources are processed in order (later entries override earlier ones):
 *   1. Built-in strata from .si files in src/strata/ (always loaded first).
 *   2. Extra strata sources — Silicon source strings from external strata
 *      files loaded by the caller (e.g. via the --strata CLI flag).
 *   3. Inline user-defined @stratum_operator / @stratum_keyword definitions
 *      found in the top-level elements of `ast`.
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

  // Phase A: built-in strata from .si files.
  for (const elab of parseBuiltinStrata()) {
    registerElaboration(registry, elab)
  }

  // Phase B: external strata files supplied by the caller.
  for (const source of extraSources) {
    for (const elab of parseStrataSource(source)) {
      registerElaboration(registry, elab)
    }
  }

  // Phase C: inline user-defined strata from the program AST.
  for (const element of ast.elements as any[]) {
    let elab: Elaboration | undefined
    if (element.type === 'Elaboration') {
      elab = element as Elaboration
    } else if (element.type === 'Element' && element.kind === 'elaboration') {
      elab = element.value as Elaboration
    }
    if (elab) registerElaboration(registry, elab)
  }

  // Phase D: register built-in IR expanders (control-flow strata lowering hooks).
  for (const [intrinsic, fn] of Object.entries(builtinExpanders)) {
    registerExpander(registry, intrinsic, fn)
  }

  // Phase E: register built-in definition expanders (definition-kind lowering hooks).
  for (const [codegenKind, exp] of Object.entries(builtinDefExpanders)) {
    registerDefExpander(registry, codegenKind, exp)
  }

  return registry
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Register a single Elaboration node into the registry. */
function registerElaboration(registry: ElaboratorRegistry, elab: Elaboration): void {
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
}

/** Parse a Silicon source string and return all Elaboration nodes found. */
function parseStrataSource(source: string): Elaboration[] {
  const match = parse(source)
  const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
  return (ast.elements as any[]).filter(el => el.type === 'Elaboration') as Elaboration[]
}

/** Built-in strata loaded from .si files in src/strata/. */
function parseBuiltinStrata(): Elaboration[] {
  return parseStrataSource(loadBuiltinStrata())
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
