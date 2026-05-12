/**
 * AST Elaboration Pass
 *
 * This module performs semantic elaboration of the AST by:
 * 1. Building an elaborator registry from @stratum definitions
 * 2. Walking the AST to attach semantic information to operators
 *
 * Elaboration happens after AST construction but before code generation.
 * It enriches the AST with semantic knowledge about operators/keywords.
 *
 * The elaborator handles both AST shapes:
 *   - "flat": raw nodes (BinaryOp, FunctionCall, etc.) produced by toAst.ts
 *   - "wrapped": ASTFactory-wrapped nodes used in unit tests
 *
 * @see registry.ts - The registry lookup infrastructure
 * @see astNodes.ts - AST node definitions
 */

import {
  type Program,
  type Element,
  type Item,
  type ASTNode,
  type Statement,
  type ExpressionStart,
  type BinOp,
  type ExpressionEnd,
  type FunctionCall,
  type Elaboration,
  type Block,
  type Definition,
  type Assignment,
  ASTFactory
} from '../ast/astNodes'
import {
  createElaboratorRegistry,
  registerElaborator,
  lookupOperator,
  lookupDefKindEntry,
  type ElaboratorRegistry
} from './registry'
import { StrataType, type StrataNode, strataTypeFromIntrinsic } from './strataenum'
import { registerDefKind, type CodegenKind } from './defkinds'
import { loadBuiltinStrata } from '../strata/index'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

export interface ElaborationError {
  keyword: string
  message: string
}

export interface ElaborateResult {
  program: Program
  registry: ElaboratorRegistry
  errors: ElaborationError[]
}

/**
 * Main entry point for elaboration.
 *
 * Two-phase process:
 * 1. Parse builtin elaborators + extract user elaborators from AST
 * 2. Walk AST and attach semantic nodes to operators
 */
export default function elaborate(ast: Program): ElaborateResult {
  const registry = buildElaboratorRegistry(ast)
  const { program, errors } = elaborateAST(ast, registry)
  return { program, registry, errors }
}

// ---------------------------------------------------------------------------
// Phase 1: Build registry
// ---------------------------------------------------------------------------

function buildElaboratorRegistry(ast: Program): ElaboratorRegistry {
  const registry = createElaboratorRegistry()

  // Parse and register builtin strata from .si files in src/strata/.
  // Strata with WASM::def_* intrinsics are also registered as def-kinds.
  for (const elab of parseBuiltinStrata()) {
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

  // Walk the AST for user-defined @stratum definitions.
  // Handles both the flat shape (element.type === 'Elaboration') from the parser
  // and the wrapped shape (element.type === 'Element', element.kind === 'elaboration')
  // from ASTFactory-built programs (used in unit tests).
  for (const element of ast.elements as any[]) {
    if (element.type === 'Elaboration') {
      registerElaborator(registry, element.kind, symbolToString(element.symbol), elaborationToStrataNode(element))
    } else if (element.type === 'Element' && element.kind === 'elaboration') {
      const elab = element.value as Elaboration
      registerElaborator(registry, elab.kind, symbolToString(elab.symbol), elaborationToStrataNode(elab))
    }
  }

  return registry
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

/** Normalize an Elaboration symbol to a plain string. */
function symbolToString(symbol: any): string {
  if (typeof symbol === 'string') return symbol
  if (symbol && symbol.type === 'StringLiteral') return symbol.value
  return String(symbol)
}

/** Parse a Silicon source string and return all Elaboration nodes found. */
function parseStrataSource(source: string): Elaboration[] {
  const match = parse(source)
  const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
  return (ast.elements as any[]).filter(el => el.type === 'Elaboration') as Elaboration[]
}

/** Builtin strata (@if, @loop, operators, …) loaded from .si files in src/strata/. */
function parseBuiltinStrata(): Elaboration[] {
  return parseStrataSource(loadBuiltinStrata())
}

/**
 * Convert an Elaboration AST node to a StrataNode. Extracts the WASM intrinsic
 * reference and body template from the body so downstream phases (codegen,
 * typechecker) can use them without re-walking the body.
 */
function elaborationToStrataNode(elaboration: Elaboration): StrataNode {
  const intrinsic = extractIntrinsicFromBody(elaboration.semantics)
  const bodyTemplate = extractBodyTemplate(elaboration.semantics as any, elaboration.nodeParamName)
  const kind = elaboration.kind as 'operator' | 'keyword'
  return {
    type: strataTypeFromIntrinsic(intrinsic, kind),
    discriminant: symbolToString(elaboration.symbol),
    data: {
      nodeParamName: elaboration.nodeParamName,
      body: elaboration.semantics,
      intrinsic,
      bodyTemplate,
    },
  }
}

/**
 * Walk the strata body AST and extract the argument pattern from the first
 * WASM function call. Returns `{ intrinsic, argRefs }` where `argRefs` maps
 * each call argument to 'left', 'right', or 'unknown' based on whether it
 * references `{nodeParamName}.left` or `{nodeParamName}.right`.
 *
 * This drives body-level arg substitution in codegen so that the strata body
 * actually determines operand order, rather than the compiler hardcoding it.
 */
function extractBodyTemplate(
  body: any,
  nodeParamName: string
): { intrinsic: string; argRefs: Array<'left' | 'right' | 'unknown'> } | undefined {
  if (!body || !Array.isArray(body.items)) return undefined
  for (const item of body.items) {
    if (!item || typeof item !== 'object') continue
    // Item.value for 'expression' kind is the result of ExpressionStart_binChain,
    // which with no binary ops returns the ExpressionEnd result directly —
    // a FunctionCall node in this context.
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
    return { intrinsic, argRefs }
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

/**
 * Walk an AST node tree looking for the first FunctionCall whose name path
 * starts with 'WASM'. Returns the full path as a string (e.g. 'WASM::i32_add').
 */
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

// ---------------------------------------------------------------------------
// Phase 2: Walk AST, attach semantics, and validate Def-Kind schemas
// ---------------------------------------------------------------------------

function elaborateAST(ast: Program, registry: ElaboratorRegistry): { program: Program; errors: ElaborationError[] } {
  const errors: ElaborationError[] = []
  const elements = (ast.elements as any[]).map(el => elaborateNode(el, registry, errors))
  return { program: { type: 'Program', elements }, errors }
}

/**
 * Dispatch on any node type — handles both flat (parser) and wrapped
 * (ASTFactory) AST shapes.
 */
function elaborateNode(node: any, registry: ElaboratorRegistry, errors: ElaborationError[]): any {
  if (!node || typeof node !== 'object') return node

  switch (node.type) {
    // Flat AST leaves — no sub-elaboration needed
    case 'IntLiteral':
    case 'FloatLiteral':
    case 'BooleanLiteral':
    case 'StringLiteral':
    case 'Namespace':
    case 'Elaboration':
    case 'DocComment':
    case 'TypeAnnotation':
    case 'TypedIdentifier':
    case 'GenericParams':
    case 'Parameter':
      return node

    // Flat AST composites
    case 'BinaryOp':
      return elaborateBinOp(node, registry, errors)

    case 'FunctionCall':
      return { ...node, args: node.args.map((a: any) => elaborateNode(a, registry, errors)) }

    case 'Assignment':
      return { ...node, value: elaborateNode(node.value, registry, errors) }

    case 'Definition': {
      const defEntry = lookupDefKindEntry(registry, node.keyword)

      if (!defEntry) {
        errors.push({
          keyword: node.keyword,
          message: `Unknown definition keyword '${node.keyword}' — no @stratum is registered for it`,
        })
        return node
      }

      // Schema validation: check the definition against the Def-Kind's declared schema.
      if (!defEntry.allowsParams && node.params && node.params.length > 0) {
        errors.push({
          keyword: node.keyword,
          message: `'${node.keyword}' does not accept parameters`,
        })
      }
      if (!defEntry.allowsBinding && node.binding) {
        errors.push({
          keyword: node.keyword,
          message: `'${node.keyword}' does not accept a binding (:= ...)`,
        })
      }
      if (!defEntry.allowsGenerics && node.generics) {
        errors.push({
          keyword: node.keyword,
          message: `'${node.keyword}' does not accept generic parameters`,
        })
      }

      const hook = defEntry.codegenKind
      const elaborated = { ...node, hook }
      if (!elaborated.binding) return elaborated
      return { ...elaborated, binding: { ...elaborated.binding, expression: elaborateNode(elaborated.binding.expression, registry, errors) } }
    }

    case 'Block':
      return elaborateBlock(node, registry, errors)

    // Wrapped AST (ASTFactory shape) — used in unit tests
    case 'Program':
      return { ...node, elements: node.elements.map((el: any) => elaborateNode(el, registry, errors)) }

    case 'Element': {
      if (node.kind === 'elaboration' || node.kind === 'docComment') return node
      if (node.kind === 'item') return { ...node, value: elaborateNode(node.value, registry, errors) }
      return node
    }

    case 'Item': {
      if (node.kind === 'statement' || node.kind === 'expression') {
        return { ...node, value: elaborateNode(node.value, registry, errors) }
      }
      return node
    }

    case 'Statement': {
      if (node.kind === 'assignment' || node.kind === 'definition') {
        return { ...node, value: elaborateNode(node.value, registry, errors) }
      }
      return node
    }

    case 'ExpressionStart': {
      if (node.kind === 'binOp') return { ...node, value: elaborateBinOp(node.value, registry, errors) }
      return { ...node, value: elaborateNode(node.value, registry, errors) }
    }

    case 'ExpressionEnd':
      return { ...node, value: elaborateNode(node.value, registry, errors) }

    case 'Literal':
      return { ...node, value: elaborateNode(node.value, registry, errors) }

    case 'ArrayLiteral':
      return { ...node, elements: node.elements.map((e: any) => elaborateNode(e, registry, errors)) }

    case 'Binding':
      return { ...node, expression: elaborateNode(node.expression, registry, errors) }

    default:
      return node
  }
}

function elaborateBlock(block: any, registry: ElaboratorRegistry, errors: ElaborationError[]): any {
  return {
    ...block,
    items: block.items.map((i: any) => elaborateNode(i, registry, errors)),
    trailing: block.trailing ? elaborateNode(block.trailing, registry, errors) : undefined,
  }
}

function elaborateBinOp(binOp: any, registry: ElaboratorRegistry, errors: ElaborationError[]): any {
  const left = elaborateNode(binOp.left, registry, errors)
  const right = elaborateNode(binOp.right, registry, errors)
  const semantics = lookupOperator(registry, binOp.operator)
  return { ...binOp, left, right, semantics }
}
