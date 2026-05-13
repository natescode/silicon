/**
 * AST Elaboration Pass
 *
 * Pure AST walker. Takes a pre-built ElaboratorRegistry (produced by
 * buildStrataRegistry in strataLoader.ts) and annotates the AST:
 *
 *   - Attaches the matching StrataNode as `semantics` on every BinaryOp.
 *   - Stamps the `hook` (CodegenKind) onto every Definition node so codegen
 *     knows how to lower it without consulting the registry again.
 *   - Validates def-kind schemas: params, binding, generics constraints.
 *
 * When called without a pre-built registry (the `registry?` overload),
 * buildStrataRegistry is called internally for backward compatibility.
 *
 * @see strataLoader.ts - Builds the registry from strata definitions.
 * @see registry.ts     - Registry lookup infrastructure.
 */

import {
  type Program,
  type Item,
  type ExpressionStart,
  type BinOp,
  type Elaboration,
} from '../ast/astNodes'
import {
  lookupOperator,
  lookupDefKindEntry,
  type ElaboratorRegistry,
} from './registry'
import { buildStrataRegistry } from './strataLoader'

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
 * Elaborate the AST using the provided registry. If no registry is given,
 * one is built from the program's strata definitions (backward-compatible path).
 *
 * @param ast          The parsed Silicon program AST.
 * @param registry     Pre-built registry (pass one to include external strata).
 * @param extraSources Extra Silicon source strings to load strata from when no
 *                     registry is provided (passed through to buildStrataRegistry).
 */
export default function elaborate(
  ast: Program,
  registry?: ElaboratorRegistry,
  extraSources: string[] = [],
): ElaborateResult {
  const reg = registry ?? buildStrataRegistry(ast, extraSources)
  const { program, errors } = elaborateAST(ast, reg)
  return { program, registry: reg, errors }
}

// ---------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------

function elaborateAST(
  ast: Program,
  registry: ElaboratorRegistry,
): { program: Program; errors: ElaborationError[] } {
  const errors: ElaborationError[] = []
  const elements = (ast.elements as any[]).map(el => elaborateNode(el, registry, errors))
  return { program: { type: 'Program', elements }, errors }
}

function elaborateNode(node: any, registry: ElaboratorRegistry, errors: ElaborationError[]): any {
  if (!node || typeof node !== 'object') return node

  switch (node.type) {
    // Leaves — no sub-elaboration needed.
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

    case 'BinaryOp':
      return elaborateBinOp(node, registry, errors)

    case 'FunctionCall':
      return { ...node, args: node.args.map((a: any) => elaborateNode(a, registry, errors)) }

    case 'Assignment':
      return { ...node, value: elaborateNode(node.value, registry, errors) }

    case 'Definition':
      return elaborateDefinition(node, registry, errors)

    case 'Block':
      return elaborateBlock(node, registry, errors)

    // Wrapped AST shape (ASTFactory — used in unit tests).
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

function elaborateDefinition(
  node: any,
  registry: ElaboratorRegistry,
  errors: ElaborationError[],
): any {
  const defEntry = lookupDefKindEntry(registry, node.keyword)

  if (!defEntry) {
    errors.push({
      keyword: node.keyword,
      message: `Unknown definition keyword '${node.keyword}' — no @stratum is registered for it`,
    })
    return node
  }

  if (!defEntry.allowsParams && node.params && node.params.length > 0) {
    errors.push({ keyword: node.keyword, message: `'${node.keyword}' does not accept parameters` })
  }
  if (!defEntry.allowsBinding && node.binding) {
    errors.push({ keyword: node.keyword, message: `'${node.keyword}' does not accept a binding (:= ...)` })
  }
  if (!defEntry.allowsGenerics && node.generics) {
    errors.push({ keyword: node.keyword, message: `'${node.keyword}' does not accept generic parameters` })
  }

  const hook = defEntry.codegenKind
  const elaborated = { ...node, hook }
  if (!elaborated.binding) return elaborated
  return {
    ...elaborated,
    binding: {
      ...elaborated.binding,
      expression: elaborateNode(elaborated.binding.expression, registry, errors),
    },
  }
}

function elaborateBlock(
  block: any,
  registry: ElaboratorRegistry,
  errors: ElaborationError[],
): any {
  return {
    ...block,
    items: block.items.map((i: any) => elaborateNode(i, registry, errors)),
    trailing: block.trailing ? elaborateNode(block.trailing, registry, errors) : undefined,
  }
}

function elaborateBinOp(
  binOp: any,
  registry: ElaboratorRegistry,
  errors: ElaborationError[],
): any {
  const left = elaborateNode(binOp.left, registry, errors)
  const right = elaborateNode(binOp.right, registry, errors)
  const semantics = lookupOperator(registry, binOp.operator)
  return { ...binOp, left, right, semantics }
}
