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
  type ElaboratorRegistry,
} from './registry'
import { StrataType, type StrataNode, type StrataData, strataTypeFromIntrinsic } from './strataenum'
import { intrinsicSignature } from '../types/intrinsicSig'
import { getWasmIntrinsic } from '../intrinsics'
import { registerDefKind, type CodegenKind } from './defkinds'
import { loadBuiltinStrata } from '../strata/index'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an ElaboratorRegistry from all strata visible in the program.
 *
 * Two sources are processed:
 *   1. Built-in strata from .si files in src/strata/ (always loaded first).
 *   2. User-defined @stratum_operator / @stratum_keyword definitions found
 *      in the top-level elements of `ast` (override builtins when symbols clash).
 */
export function buildStrataRegistry(ast: Program): ElaboratorRegistry {
  const registry = createElaboratorRegistry()

  // Phase A: built-in strata from .si files.
  for (const elab of parseBuiltinStrata()) {
    registerElaboration(registry, elab)
  }

  // Phase B: user-defined strata from the program AST.
  for (const element of ast.elements as any[]) {
    let elab: Elaboration | undefined
    if (element.type === 'Elaboration') {
      elab = element as Elaboration
    } else if (element.type === 'Element' && element.kind === 'elaboration') {
      elab = element.value as Elaboration
    }
    if (elab) registerElaboration(registry, elab)
  }

  return registry
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Register a single Elaboration node into the registry. */
function registerElaboration(registry: ElaboratorRegistry, elab: Elaboration): void {
  const node = elaborationToStrataNode(elab)
  const symbol = symbolToString(elab.symbol)
  registerElaborator(registry, elab.kind, symbol, node)

  const codegenKind = codegenKindFromIntrinsic(node.data?.intrinsic)
  if (codegenKind) {
    registerDefKind(registry.defKinds, {
      keyword: symbol,
      codegenKind,
      allowsParams: codegenKind === 'function' || codegenKind === 'extern',
      allowsBinding: codegenKind !== 'extern',
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

/** Map a WASM::def_* intrinsic name to the corresponding codegen kind. */
function codegenKindFromIntrinsic(intrinsic: string | undefined): CodegenKind | undefined {
  if (intrinsic === 'WASM::def_function') return 'function'
  if (intrinsic === 'WASM::def_global') return 'global'
  if (intrinsic === 'WASM::def_extern') return 'extern'
  if (intrinsic === 'WASM::def_type_alias') return 'type_alias'
  if (intrinsic === 'WASM::def_type_distinct') return 'type_distinct'
  if (intrinsic === 'WASM::def_type_sum') return 'type_sum'
  if (intrinsic === 'WASM::def_local') return 'local'
  return undefined
}

/**
 * Pre-compute the f32 WAT instruction for an i32 intrinsic, if one exists.
 * Strips signed/unsigned suffixes (_s, _u) that have no f32 equivalent.
 * Returns the ready-to-emit WAT instruction string (e.g. 'f32.add'), or
 * undefined when no f32 counterpart exists (bitwise ops, memory ops, etc.).
 */
function deriveFloatVariant(intrinsic: string): string | undefined {
  if (!intrinsic.startsWith('WASM::i32_')) return undefined
  const f32Name = intrinsic.replace('WASM::i32_', 'WASM::f32_')
  const found =
    getWasmIntrinsic(f32Name) ??
    getWasmIntrinsic(f32Name.replace(/_[su]$/, ''))
  return found?.wasmInstr
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
    floatVariant: intrinsic ? deriveFloatVariant(intrinsic) : undefined,
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
    const name = fc.name
    if (!name || name.type !== 'Namespace' || name.path?.[0] !== 'WASM') continue
    const intrinsic = (name.path as string[]).join('::')
    const argRefs = (fc.args ?? []).map((arg: any): 'left' | 'right' | 'unknown' => {
      const ns = findNamespace(arg)
      if (!ns) return 'unknown'
      const nsStr = (ns.path as string[]).join('.')
      if (nsStr === `${nodeParamName}.left`) return 'left'
      if (nsStr === `${nodeParamName}.right`) return 'right'
      return 'unknown'
    })
    steps.push({ intrinsic, argRefs })
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
    if (name && Array.isArray(name.path) && name.path[0] === 'WASM') {
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
