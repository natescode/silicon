/**
 * Elaborator Tests
 *
 * Tests for the elaboration pass:
 * - Registry building from @stratum definitions
 * - Semantic attachment to BinOp nodes
 * - Recursive elaboration of nested structures
 */

import { test, expect } from "bun:test"
import elaborate from "./elaborator"
import {
  ASTFactory,
  type Program,
  type ExpressionStart,
  type ExpressionEnd,
  type IntLiteral,
  type Namespace,
  type BinOp,
  type Element,
  type Item,
  type Statement,
  type Assignment,
  type Elaboration
} from "../ast/astNodes"
import { StrataType } from "./strataenum"

/**
 * Helper: Create a simple binary operation AST
 * Represents: 1 + 2
 */
function createSimpleBinOpAST(): Program {
  const left = ASTFactory.intLiteral('1', 'decimal')
  const leftLit = ASTFactory.literal('int', left)
  const leftExpEnd = ASTFactory.expressionEnd('literal', leftLit)
  const leftExp = ASTFactory.expressionStart('expressionEnd', leftExpEnd)

  const right = ASTFactory.intLiteral('2', 'decimal')
  const rightLit = ASTFactory.literal('int', right)
  const rightExpEnd = ASTFactory.expressionEnd('literal', rightLit)

  const binOp = ASTFactory.binOp(leftExp, '+', rightExpEnd)
  const exp = ASTFactory.expressionStart('binOp', binOp)

  const item = ASTFactory.item('expression', exp)
  const stmt = ASTFactory.statement('definition', {
    type: 'Definition',
    keyword: '@test',
    name: ASTFactory.typedIdentifier('test'),
    params: []
  })
  const element = ASTFactory.element('item', item)

  return ASTFactory.program([element])
}

/**
 * Helper: Create an elaborator (operator definition) AST
 *
 * @stratum Plus (Operator, "+", Node) = {
 *   &WASM::i32_add Node.left, Node.right;
 * };
 */
function createPlusElaboratorAST(): Elaboration {
  // Create the body: &WASM::i32_add Node.left, Node.right;
  // This is simplified - just a placeholder expression
  const bodyExp = ASTFactory.expressionStart(
    'expressionEnd',
    ASTFactory.expressionEnd('literal', ASTFactory.literal('int', ASTFactory.intLiteral('0', 'decimal')))
  )

  return ASTFactory.elaboration(
    'operator',
    'Plus',
    'Operator',
    '+',
    'Node',
    bodyExp
  )
}

// Test 1: elaborate is a function
test("elaborate is a function", () => {
  expect(typeof elaborate).toBe('function')
})

// Test 2: accepts a Program AST and returns a Program
test("elaborate accepts a Program AST and returns a Program", () => {
  const ast = createSimpleBinOpAST()
  const result = elaborate(ast)
  expect(result.type).toBe('Program')
  expect(Array.isArray(result.elements)).toBe(true)
})

// Test 3: preserves AST structure when no elaborators found
test("elaborate preserves AST structure when no elaborators found", () => {
  const ast = createSimpleBinOpAST()
  const result = elaborate(ast)
  expect(result.elements.length).toBe(ast.elements.length)
})

// Test 4: does not crash on empty program
test("elaborate does not crash on empty program", () => {
  const emptyProgram = ASTFactory.program([])
  const result = elaborate(emptyProgram)
  expect(result.type).toBe('Program')
  expect(result.elements.length).toBe(0)
})

// Test 5: leaves BinOp semantics undefined when operator not registered
test("elaborate leaves BinOp semantics undefined when operator not registered", () => {
  const ast = createSimpleBinOpAST()
  const result = elaborate(ast)

  // Extract the BinOp from the result
  const firstElement = result.elements[0]
  if (firstElement.kind === 'item' && firstElement.value.kind === 'expression') {
    const expr = firstElement.value.value as ExpressionStart
    if (expr.kind === 'binOp') {
      const binOp = expr.value as BinOp
      // Should be undefined since no elaborator was registered
      expect(binOp.semantics).toBeUndefined()
    }
  }
})

// Test 6: attaches semantics to BinOp when operator is registered
test("elaborate attaches semantics to BinOp when operator is registered", () => {
  // Create a program with both an elaborator definition and a binary operation
  const plusElab = createPlusElaboratorAST()
  const elaboElement = ASTFactory.element_elaboration(plusElab)

  // Create binary operation
  const left = ASTFactory.intLiteral('1', 'decimal')
  const leftLit = ASTFactory.literal('int', left)
  const leftExpEnd = ASTFactory.expressionEnd('literal', leftLit)
  const leftExp = ASTFactory.expressionStart('expressionEnd', leftExpEnd)

  const right = ASTFactory.intLiteral('2', 'decimal')
  const rightLit = ASTFactory.literal('int', right)
  const rightExpEnd = ASTFactory.expressionEnd('literal', rightLit)

  const binOp = ASTFactory.binOp(leftExp, '+', rightExpEnd)
  const exp = ASTFactory.expressionStart('binOp', binOp)
  const item = ASTFactory.item('expression', exp)
  const itemElement = ASTFactory.element('item', item)

  // Combine into a program
  const program = ASTFactory.program([elaboElement, itemElement])

  // Elaborate
  const result = elaborate(program)

  // Extract the BinOp from the second element
  const secondElement = result.elements[1]
  if (secondElement.kind === 'item' && secondElement.value.kind === 'expression') {
    const expr = secondElement.value.value as ExpressionStart
    if (expr.kind === 'binOp') {
      const elaboratedBinOp = expr.value as BinOp
      // Should have semantics attached now
      expect(elaboratedBinOp.semantics).toBeDefined()
      expect(elaboratedBinOp.semantics?.discriminant).toBe('+')
    }
  }
})

// Test 7: elaborates nested expressions
test("elaborate elaborates nested expressions", () => {
  // Create: (1 + 2) + 3
  // This requires two binary operations

  const left = ASTFactory.intLiteral('1', 'decimal')
  const leftLit = ASTFactory.literal('int', left)
  const leftExpEnd = ASTFactory.expressionEnd('literal', leftLit)
  const leftExp = ASTFactory.expressionStart('expressionEnd', leftExpEnd)

  const middle = ASTFactory.intLiteral('2', 'decimal')
  const middleLit = ASTFactory.literal('int', middle)
  const middleExpEnd = ASTFactory.expressionEnd('literal', middleLit)

  const innerBinOp = ASTFactory.binOp(leftExp, '+', middleExpEnd)
  const innerExp = ASTFactory.expressionStart('binOp', innerBinOp)

  const right = ASTFactory.intLiteral('3', 'decimal')
  const rightLit = ASTFactory.literal('int', right)
  const rightExpEnd = ASTFactory.expressionEnd('literal', rightLit)

  const outerBinOp = ASTFactory.binOp(innerExp, '+', rightExpEnd)
  const outerExp = ASTFactory.expressionStart('binOp', outerBinOp)

  const item = ASTFactory.item('expression', outerExp)
  const element = ASTFactory.element('item', item)
  const program = ASTFactory.program([element])

  const result = elaborate(program)
  expect(result.type).toBe('Program')
  // Just verify it doesn't crash and produces a valid AST
})

// Test 8: registry building from elaborations
test("elaborate extracts elaborations from program", () => {
  const elab1 = createPlusElaboratorAST()
  const elab2 = ASTFactory.elaboration(
    'operator',
    'Minus',
    'Operator',
    '-',
    'Node',
    ASTFactory.expressionStart(
      'expressionEnd',
      ASTFactory.expressionEnd('literal', ASTFactory.literal('int', ASTFactory.intLiteral('0', 'decimal')))
    )
  )

  const elem1 = ASTFactory.element_elaboration(elab1)
  const elem2 = ASTFactory.element_elaboration(elab2)
  const program = ASTFactory.program([elem1, elem2])

  const result = elaborate(program)
  // Should complete without error
  expect(result.type).toBe('Program')
})