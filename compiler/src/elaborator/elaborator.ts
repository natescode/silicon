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
import { StrataType, type StrataNode } from './strataenum'
import { BUILTIN_ELABORATORS_SOURCE } from './builtins'
import { BUILTIN_DEF_KINDS, registerDefKind } from './defkinds'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

export interface ElaborateResult {
  program: Program
  registry: ElaboratorRegistry
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
  const program = elaborateAST(ast, registry)
  return { program, registry }
}

// ---------------------------------------------------------------------------
// Phase 1: Build registry
// ---------------------------------------------------------------------------

function buildElaboratorRegistry(ast: Program): ElaboratorRegistry {
  const registry = createElaboratorRegistry()

  // Register builtin Def-Kinds (@let → function, etc.)
  for (const entry of BUILTIN_DEF_KINDS) {
    registerDefKind(registry.defKinds, entry)
  }

  // Parse and register builtin elaborators from Silicon source (with bodies).
  for (const elab of parseBuiltinElaborators()) {
    registerElaborator(registry, elab.kind, symbolToString(elab.symbol), elaborationToStrataNode(elab))
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

/** Normalize an Elaboration symbol to a plain string. */
function symbolToString(symbol: any): string {
  if (typeof symbol === 'string') return symbol
  if (symbol && symbol.type === 'StringLiteral') return symbol.value
  return String(symbol)
}

/**
 * Parse BUILTIN_ELABORATORS_SOURCE with the Silicon parser so builtin strata
 * have their bodies (and therefore intrinsic references) stored.
 */
function parseBuiltinElaborators(): Elaboration[] {
  const match = parse(BUILTIN_ELABORATORS_SOURCE)
  const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
  const elaborations: Elaboration[] = []
  for (const element of ast.elements as any[]) {
    if (element.type === 'Elaboration') {
      elaborations.push(element as Elaboration)
    }
  }
  return elaborations
}

/**
 * Convert an Elaboration AST node to a StrataNode. Extracts the WASM intrinsic
 * reference from the body so downstream phases (codegen, typechecker) can use
 * it without re-walking the body.
 */
function elaborationToStrataNode(elaboration: Elaboration): StrataNode {
  const intrinsic = extractIntrinsicFromBody(elaboration.semantics)
  return {
    type: StrataType.Operator,
    discriminant: symbolToString(elaboration.symbol),
    data: {
      nodeParamName: elaboration.nodeParamName,
      body: elaboration.semantics,
      intrinsic,
    },
  }
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
// Phase 2: Walk AST and attach semantics
// ---------------------------------------------------------------------------

function elaborateAST(ast: Program, registry: ElaboratorRegistry): Program {
  const elements = (ast.elements as any[]).map(el => elaborateNode(el, registry))
  return { type: 'Program', elements }
}

/**
 * Dispatch on any node type — handles both flat (parser) and wrapped
 * (ASTFactory) AST shapes.
 */
function elaborateNode(node: any, registry: ElaboratorRegistry): any {
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
      return elaborateBinOp(node, registry)

    case 'FunctionCall':
      return { ...node, args: node.args.map((a: any) => elaborateNode(a, registry)) }

    case 'Assignment':
      return { ...node, value: elaborateNode(node.value, registry) }

    case 'Definition': {
      const defEntry = lookupDefKindEntry(registry, node.keyword)
      const hook = defEntry ? defEntry.codegenKind : false
      const elaborated = { ...node, hook }
      if (!elaborated.binding) return elaborated
      return { ...elaborated, binding: { ...elaborated.binding, expression: elaborateNode(elaborated.binding.expression, registry) } }
    }

    case 'Block':
      return elaborateBlock(node, registry)

    // Wrapped AST (ASTFactory shape) — used in unit tests
    case 'Program':
      return { ...node, elements: node.elements.map((el: any) => elaborateNode(el, registry)) }

    case 'Element': {
      if (node.kind === 'elaboration' || node.kind === 'docComment') return node
      if (node.kind === 'item') return { ...node, value: elaborateNode(node.value, registry) }
      return node
    }

    case 'Item': {
      if (node.kind === 'statement' || node.kind === 'expression') {
        return { ...node, value: elaborateNode(node.value, registry) }
      }
      return node
    }

    case 'Statement': {
      if (node.kind === 'assignment' || node.kind === 'definition') {
        return { ...node, value: elaborateNode(node.value, registry) }
      }
      return node
    }

    case 'ExpressionStart': {
      if (node.kind === 'binOp') return { ...node, value: elaborateBinOp(node.value, registry) }
      return { ...node, value: elaborateNode(node.value, registry) }
    }

    case 'ExpressionEnd':
      return { ...node, value: elaborateNode(node.value, registry) }

    case 'Literal':
      return { ...node, value: elaborateNode(node.value, registry) }

    case 'ArrayLiteral':
      return { ...node, elements: node.elements.map((e: any) => elaborateNode(e, registry)) }

    case 'Binding':
      return { ...node, expression: elaborateNode(node.expression, registry) }

    default:
      return node
  }
}

function elaborateBlock(block: any, registry: ElaboratorRegistry): any {
  return {
    ...block,
    items: block.items.map((i: any) => elaborateNode(i, registry)),
    trailing: block.trailing ? elaborateNode(block.trailing, registry) : undefined,
  }
}

function elaborateBinOp(binOp: any, registry: ElaboratorRegistry): any {
  const left = elaborateNode(binOp.left, registry)
  const right = elaborateNode(binOp.right, registry)
  const semantics = lookupOperator(registry, binOp.operator)
  return { ...binOp, left, right, semantics }
}
