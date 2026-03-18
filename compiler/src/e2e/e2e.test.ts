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
import { addToAstSemantics, type ASTNode, type Program } from "../ast/index.ts";
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
 * Tests that strata are properly attached to operators during elaboration
 */
test("E2E: Stratum elaboration on binary operators", () => {
    const sourceCode = loadExample("stratum_definition.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.ast).toBeDefined();
    expect(result.elaboratedAST).toBeDefined();
    expect(result.wat).toBeDefined();
    // The elaborator should attach stratum information to the AST
    expect(result.elaboratedAST.elements).toBeDefined();
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
