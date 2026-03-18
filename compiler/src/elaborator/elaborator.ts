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
  type Assignment
} from '../ast/astNodes'
import {
  createElaboratorRegistry,
  registerElaborator,
  lookupOperator,
  type ElaboratorRegistry
} from './registry'
import { StrataType, type StrataNode, createOperatorNode } from './strataenum'
import { BUILTIN_ELABORATORS_SOURCE } from './builtins'

/**
 * Main entry point for elaboration
 *
 * Two-phase process:
 * 1. Parse builtin elaborators + extract user elaborators from AST
 * 2. Walk AST and attach semantic nodes to operators
 *
 * @param ast - The AST to elaborate
 * @returns An elaborated AST with semantics attached to operators
 */
export default function elaborate(ast: Program): Program {
  // Phase 1: Build registry from @stratum definitions in the AST
  const registry = buildElaboratorRegistry(ast)

  // Phase 2: Walk AST and attach semantics
  const elaboratedProgram = elaborateAST(ast, registry)

  return elaboratedProgram
}

/**
 * Phase 1: Build the elaborator registry
 *
 * Scans the AST for Elaboration nodes and registers them in the registry.
 * Returns an in-memory registry ready for lookups.
 *
 * @param ast - The program AST
 * @returns An ElaboratorRegistry with all found elaborators registered
 */
function buildElaboratorRegistry(ast: Program): ElaboratorRegistry {
  const registry = createElaboratorRegistry()

  // TODO: Parse builtins from BUILTIN_ELABORATORS_SOURCE
  // For now, we'll skip this as it requires parsing Silicon source,
  // which creates circular dependency. Will be addressed in integration phase.

  // Walk the AST looking for Elaboration nodes
  walkForElaborations(ast, (elaboration: Elaboration) => {
    // Convert the Elaboration AST node to a StrataNode
    const strataNode = elaborationToStrataNode(elaboration)

    // Register it in the registry
    registerElaborator(
      registry,
      elaboration.kind,
      elaboration.symbol,
      strataNode
    )
  })

  return registry
}

/**
 * Convert an Elaboration AST node to a StrataNode for storage in registry
 *
 * @param elaboration - The Elaboration AST node
 * @returns A StrataNode containing the semantic information
 */
function elaborationToStrataNode(elaboration: Elaboration): StrataNode {
  return createOperatorNode(elaboration.symbol, {
    body: elaboration.semantics,
    nodeParamName: elaboration.nodeParamName
  })
}

/**
 * Phase 2: Elaborate the AST
 *
 * Walks the AST and attaches semantic information (StrataNode) to
 * BinOp nodes when their operator is found in the registry.
 *
 * @param ast - The AST to elaborate
 * @param registry - The elaborator registry
 * @returns An elaborated AST
 */
function elaborateAST(ast: Program, registry: ElaboratorRegistry): Program {
  const elements = ast.elements.map(el => elaborateElement(el, registry))
  return { type: 'Program', elements }
}

/**
 * Recursively elaborate an Element
 */
function elaborateElement(element: Element, registry: ElaboratorRegistry): Element {
  if (element.kind === 'elaboration' || element.kind === 'docComment') {
    // Elaborations and doc comments don't need elaboration themselves
    return element
  }

  if (element.kind === 'item') {
    const elaboratedItem = elaborateItem(element.value, registry)
    return { ...element, value: elaboratedItem }
  }

  return element
}

/**
 * Recursively elaborate an Item
 */
function elaborateItem(item: Item, registry: ElaboratorRegistry): Item {
  if (item.kind === 'statement') {
    const elaboratedStatement = elaborateStatement(item.value, registry)
    return { ...item, value: elaboratedStatement }
  }

  if (item.kind === 'expression') {
    const elaboratedExpression = elaborateExpressionStart(item.value, registry)
    return { ...item, value: elaboratedExpression }
  }

  return item
}

/**
 * Recursively elaborate a Statement
 */
function elaborateStatement(stmt: Statement, registry: ElaboratorRegistry): Statement {
  if (stmt.kind === 'assignment') {
    const elaboratedValue = elaborateExpressionStart(stmt.value, registry)
    return { ...stmt, value: elaboratedValue }
  }

  if (stmt.kind === 'definition') {
    const elaboratedDef = elaborateDefinition(stmt.value, registry)
    return { ...stmt, value: elaboratedDef }
  }

  return stmt
}

/**
 * Recursively elaborate a Definition
 */
function elaborateDefinition(def: Definition, registry: ElaboratorRegistry): Definition {
  if (def.binding) {
    const elaboratedBinding = elaborateExpressionEnd(def.binding.expression, registry)
    return {
      ...def,
      binding: { ...def.binding, expression: elaboratedBinding }
    }
  }

  return def
}

/**
 * Recursively elaborate an ExpressionStart
 */
function elaborateExpressionStart(
  exp: ExpressionStart,
  registry: ElaboratorRegistry
): ExpressionStart {
  if (exp.kind === 'binOp') {
    const elaboratedBinOp = elaborateBinOp(exp.value, registry)
    return { ...exp, value: elaboratedBinOp }
  }

  if (exp.kind === 'functionCall') {
    const elaboratedFuncCall = elaborateFunctionCall(exp.value, registry)
    return { ...exp, value: elaboratedFuncCall }
  }

  if (exp.kind === 'expressionEnd') {
    const elaboratedExprEnd = elaborateExpressionEnd(exp.value, registry)
    return { ...exp, value: elaboratedExprEnd }
  }

  return exp
}

/**
 * Elaborate a BinOp node
 *
 * This is the key elaboration point: look up the operator in the registry,
 * and if found, attach the semantic StrataNode to the BinOp.
 */
function elaborateBinOp(binOp: BinOp, registry: ElaboratorRegistry): BinOp {
  // Recursively elaborate sub-expressions
  const elaboratedLeft = elaborateExpressionStart(binOp.left, registry)
  const elaboratedRight = elaborateExpressionEnd(binOp.right, registry)

  // Look up semantics for this operator
  const semantics = lookupOperator(registry, binOp.operator)

  // Return the binOp with (possibly) semantics attached
  return {
    ...binOp,
    left: elaboratedLeft,
    right: elaboratedRight,
    semantics
  }
}

/**
 * Recursively elaborate a FunctionCall
 */
function elaborateFunctionCall(call: FunctionCall, registry: ElaboratorRegistry): FunctionCall {
  const elaboratedArgs = call.args.map(arg => elaborateExpressionStart(arg, registry))
  return { ...call, args: elaboratedArgs }
}

/**
 * Recursively elaborate an ExpressionEnd
 */
function elaborateExpressionEnd(
  expEnd: ExpressionEnd,
  registry: ElaboratorRegistry
): ExpressionEnd {
  if (expEnd.kind === 'literal') {
    // Literals don't need elaboration
    return expEnd
  }

  if (expEnd.kind === 'namespace') {
    // Namespaces don't need elaboration
    return expEnd
  }

  if (expEnd.kind === 'block') {
    const elaboratedBlock = elaborateBlock(expEnd.value, registry)
    return { ...expEnd, value: elaboratedBlock }
  }

  if (expEnd.kind === 'paren') {
    const elaboratedParen = elaborateExpressionStart(expEnd.value, registry)
    return { ...expEnd, value: elaboratedParen }
  }

  return expEnd
}

/**
 * Recursively elaborate a Block
 */
function elaborateBlock(block: Block, registry: ElaboratorRegistry): Block {
  const elaboratedItems = block.items.map(item => elaborateItem(item, registry))
  return { ...block, items: elaboratedItems }
}

/**
 * Helper: Walk the AST looking for Elaboration nodes
 * Calls the callback for each elaboration found
 */
function walkForElaborations(ast: Program, callback: (elab: Elaboration) => void): void {
  for (const element of ast.elements) {
    if (element.kind === 'elaboration') {
      callback(element.value as Elaboration)
    }
  }
}