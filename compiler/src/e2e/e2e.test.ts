/**
 * End-to-End Tests
 *
 * Tests the complete Silicon compilation pipeline:
 *   1. PARSE      - Source code → Parse tree
 *   2. AST        - Parse tree → Typed Abstract Syntax Tree
 *   3. ELABORATE  - Attach semantic information and stratum definitions
 *   4. CODEGEN    - AST → WebAssembly Text format
 *
 * These tests validate that source code can flow through the entire
 * compiler pipeline and produce valid WAT output, with stratum definitions
 * being properly registered and applied.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "../parser/index.ts";
import { addToAstSemantics, type ASTNode, type Program, type Elaboration, type ExpressionStart, type BinaryOp } from "../ast/index.ts";
import { addCompileSemantics } from "../codegen/index.ts";
import { elaborate } from "../elaborator/index.ts";
import { siliconGrammar } from "../grammar/index.ts";

/**
 * Helper function to compile a Silicon source string through the full pipeline
 */
function compileSource(sourceCode: string) {
    // Stage 1: Parse source code into parse tree
    let match;
    try {
        match = parse(sourceCode);
    } catch (error) {
        return {
            success: false,
            error: String(error),
            parseTree: null,
            ast: null,
            elaboratedAST: null,
            wat: null,
        };
    }

    try {
        // Stage 2: Convert parse tree into typed AST
        const ast: ASTNode = addToAstSemantics(siliconGrammar)(match).toAst();

        // Stage 2.5: Elaborate - attach semantic information and stratum definitions
        const elaboratedAST = elaborate(ast as Program);

        // Stage 3: Generate WebAssembly from AST
        const wat: string = addCompileSemantics(siliconGrammar)(match).compile();

        return {
            success: true,
            error: null,
            parseTree: match,
            ast: ast,
            elaboratedAST: elaboratedAST,
            wat: wat,
        };
    } catch (error) {
        return {
            success: false,
            error: String(error),
            parseTree: match,
            ast: null,
            elaboratedAST: null,
            wat: null,
        };
    }
}

/**
 * Load a Silicon source file from the examples directory
 */
function loadExample(filename: string): string {
    const examplePath = join(__dirname, "examples", filename);
    return readFileSync(examplePath, "utf-8");
}

/**
 * Test: Simple integer literal
 * Tests basic parsing and code generation
 */
test("E2E: Parse and compile simple integer literal", () => {
    const sourceCode = loadExample("simple_literal.si");
    const result = compileSource(sourceCode);

    if (!result.success) {
        console.error("Parse error:", result.error);
    }

    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("module");
});

/**
 * Test: String literal
 * Tests string literal parsing
 */
test("E2E: Parse and compile string literal", () => {
    const sourceCode = loadExample("string_literal.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("module");
});

/**
 * Test: Float literal
 * Tests floating point number parsing
 */
test("E2E: Parse and compile float literal", () => {
    const sourceCode = loadExample("float_literal.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.wat).toBeDefined();
});

/**
 * Test: Boolean literals
 * Tests @true and @false keyword parsing
 */
test("E2E: Parse and compile boolean true", () => {
    const sourceCode = loadExample("boolean_true.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("module");
});

test("E2E: Parse and compile boolean false", () => {
    const sourceCode = loadExample("boolean_false.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
});

/**
 * Test: Arithmetic operations
 * Tests binary operators and code generation
 */
test("E2E: Parse and compile basic arithmetic (1 + 2)", () => {
    const sourceCode = loadExample("basic_arithmetic.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain i32.add for integer addition
    expect(result.wat).toContain("add");
});

/**
 * Test: Nested expressions
 * Tests operator precedence and nested binops
 */
test("E2E: Parse and compile nested expressions", () => {
    const sourceCode = loadExample("nested_expressions.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain both add and mul operations
    expect(result.wat).toContain("add");
    expect(result.wat).toContain("mul");
});

/**
 * Test: Multiple statements
 * Tests parsing multiple expressions in sequence
 */
test("E2E: Parse and compile multiple statements", () => {
    const sourceCode = loadExample("multiple_statements.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
});

/**
 * Test: Stratum elaboration
 * Tests that operators are properly elaborated with builtin semantics
 */
test("E2E: Stratum elaboration on binary operators", () => {
    const sourceCode = loadExample("stratum_definition.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();

    // Check that the elaboration process attached semantics to the '+' operator
    const elaboratedAST = result.elaboratedAST as Program;

    // Find an expression element - need to navigate through the structure
    // Elements contain Items which contain Expressions
    let binOpNode: BinaryOp | null = null;
    for (const element of elaboratedAST.elements) {
        if (element.kind === 'item') {
            const item = element.value as Item;
            if (item.kind === 'expression') {
                const expr = item.value as ExpressionStart;
                if (expr.kind === 'binOp') {
                    binOpNode = expr.value as BinaryOp;
                    break;
                }
            }
        }
    }

    expect(binOpNode).toBeDefined();
    if (binOpNode) {
        expect(binOpNode.type).toBe('BinaryOp');
        expect(binOpNode.operator).toBe('+');
        // The elaborator should attach semantics (StrataNode) to builtin operators
        expect(binOpNode.semantics).toBeDefined();
        if (binOpNode.semantics) {
            expect(binOpNode.semantics.discriminant).toBe('+');
        }
    }

    // Verify that the WAT output contains the expected instruction
    expect(result.wat).toContain('i32.add');
});

/**
 * Test: Full pipeline integration
 * Verifies that all stages of the pipeline complete successfully
 */
test("E2E: Complete pipeline integration", () => {
    const testCases = [
        "simple_literal.si",
        "string_literal.si",
        "boolean_true.si",
        "basic_arithmetic.si",
        "nested_expressions.si",
    ];

    for (const testCase of testCases) {
        const sourceCode = loadExample(testCase);
        const result = compileSource(sourceCode);

        expect(result.success).toBe(true);
        expect(result.ast).toBeDefined();
        expect(result.elaboratedAST).toBeDefined();
        expect(result.wat).toBeDefined();
        expect(result.wat?.length).toBeGreaterThan(0);
    }
});

/**
 * Test: Error recovery on invalid syntax
 * Validates that the compiler gracefully handles parse errors
 */
test("E2E: Handle invalid syntax gracefully", () => {
    const invalidCode = "@@@ invalid syntax !!!";
    const result = compileSource(invalidCode);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
});

/**
 * Test: WAT output validity
 * Ensures generated WAT contains required module structure
 */
test("E2E: Generated WAT is structurally valid", () => {
    const sourceCode = loadExample("simple_literal.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(module");
    expect(result.wat).toContain("(memory");
    expect(result.wat).toContain("(global");
});

/**
 * Test: Builtin operators - subtraction
 * Verifies that subtraction operator generates correct i32.sub instruction
 */
test("E2E: Builtin operator - subtraction (5 - 3)", () => {
    const sourceCode = "5 - 3;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain i32.sub for subtraction
    expect(result.wat).toContain("sub");
});

/**
 * Test: Builtin operators - multiplication
 * Verifies that multiplication operator generates correct i32.mul instruction
 */
test("E2E: Builtin operator - multiplication (4 * 5)", () => {
    const sourceCode = "4 * 5;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain i32.mul for multiplication
    expect(result.wat).toContain("mul");
});

/**
 * Test: Builtin operators - division
 * Verifies that division operator generates correct i32.div_s instruction
 */
test("E2E: Builtin operator - division (10 / 2)", () => {
    const sourceCode = "10 / 2;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain div for division
    expect(result.wat).toContain("div");
});

/**
 * Test: Builtin operators - modulo
 * Verifies that modulo operator generates correct i32.rem_s instruction
 */
test("E2E: Builtin operator - modulo (10 % 3)", () => {
    const sourceCode = "10 % 3;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain rem for remainder/modulo
    expect(result.wat).toContain("rem");
});

/**
 * Test: Builtin operators - equality comparison
 * Verifies that equality operator generates correct i32.eq instruction
 */
test("E2E: Builtin operator - equality (5 == 5)", () => {
    const sourceCode = "5 == 5;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain eq for equality comparison
    expect(result.wat).toContain("eq");
});

/**
 * Test: Builtin operators - inequality comparison
 * Verifies that inequality operator generates correct i32.ne instruction
 */
test("E2E: Builtin operator - inequality (5 != 3)", () => {
    const sourceCode = "5 != 3;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain ne for inequality comparison
    expect(result.wat).toContain("ne");
});

/**
 * Test: Builtin operators - less than comparison
 * Verifies that less than operator generates correct i32.lt_s instruction
 */
test("E2E: Builtin operator - less than (3 < 5)", () => {
    const sourceCode = "3 < 5;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain lt for less than comparison
    expect(result.wat).toContain("lt");
});

/**
 * Test: Builtin operators - greater than comparison
 * Verifies that greater than operator generates correct i32.gt_s instruction
 */
test("E2E: Builtin operator - greater than (5 > 3)", () => {
    const sourceCode = "5 > 3;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain gt for greater than comparison
    expect(result.wat).toContain("gt");
});

/**
 * Test: Builtin operators - less than or equal comparison
 * Verifies that <= operator generates correct i32.le_s instruction
 */
test("E2E: Builtin operator - less than or equal (3 <= 5)", () => {
    const sourceCode = "3 <= 5;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain le for less than or equal comparison
    expect(result.wat).toContain("le");
});

/**
 * Test: Builtin operators - greater than or equal comparison
 * Verifies that >= operator generates correct i32.ge_s instruction
 */
test("E2E: Builtin operator - greater than or equal (5 >= 3)", () => {
    const sourceCode = "5 >= 3;";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain ge for greater than or equal comparison
    expect(result.wat).toContain("ge");
});

/**
 * Test: Builtin operators in complex expressions
 * Verifies that multiple builtin operators work together in one expression
 */
test("E2E: Multiple builtin operators in complex expression", () => {
    const sourceCode = "(10 - 2) * (3 + 1) / (5 - 3);";
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // Should contain all the necessary operations
    expect(result.wat).toContain("sub");
    expect(result.wat).toContain("add");
    expect(result.wat).toContain("mul");
    expect(result.wat).toContain("div");
});
