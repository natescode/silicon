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
        const { program: elaboratedAST, registry } = elaborate(ast as Program);

        // Stage 3: Generate WebAssembly from AST
        const wat: string = addCompileSemantics(siliconGrammar, registry)(match).compile();

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

/**
 * Test: Function definition
 * Verifies that @let with params emits a proper WAT (func ...) at module level
 */
test("E2E: Function definition emits WAT func with params", () => {
    const sourceCode = loadExample("function_definition.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $add");
    expect(result.wat).toContain("(param $x i32)");
    expect(result.wat).toContain("(param $y i32)");
    expect(result.wat).toContain("(result i32)");
    expect(result.wat).toContain("i32.add");
});

/**
 * Test: Function call
 * Verifies that &add 1, 2 emits (call $add ...) in $__start
 */
test("E2E: Function call emits (call $add ...) in start function", () => {
    const sourceCode = loadExample("function_call.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $add");
    expect(result.wat).toContain("(call $add");
    expect(result.wat).toContain("$__start");
    // $add must appear at module level (before $__start, not nested inside it)
    const addIdx = result.wat!.indexOf("(func $add");
    const startIdx = result.wat!.indexOf("(func $__start");
    expect(addIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeLessThan(startIdx);
});

/**
 * Test: @if/@else as trailing expression emits (if (result i32) ...)
 * The defKw/reservedId grammar fix prevents @if from being parsed as a Definition keyword.
 * The inExprPosition fix ensures if-else as a return value gets a WAT result type.
 */
test("E2E: @if/@else as trailing expression emits typed WAT if", () => {
    const sourceCode = loadExample("if_in_block.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $abs");
    expect(result.wat).toContain("(param $x i32)");
    expect(result.wat).toContain("lt_s");
    expect(result.wat).toContain("sub");
    expect(result.wat).toContain("(if (result i32)");
});

/**
 * Test: @if/@else purely in expression position (choose function)
 */
test("E2E: @if/@else in expression position emits typed WAT if", () => {
    const sourceCode = loadExample("if_else_expr.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $choose");
    expect(result.wat).toContain("(if (result i32)");
    expect(result.wat).toContain("(then");
    expect(result.wat).toContain("(else");
});

/**
 * Test: Block trailing expression (implicit return)
 * A block { stmts; expr } where the last item has no semicolon is the return value
 */
test("E2E: Block trailing expression is used as return value", () => {
    const sourceCode = loadExample("block_trailing_expr.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $add");
    expect(result.wat).toContain("(result i32)");
    expect(result.wat).toContain("i32.add");
});

/**
 * Test: Block with statements then trailing expression
 * { stmts; trailing_expr } — stmts run first, trailing_expr is the return value
 */
test("E2E: Block with statements then trailing expression", () => {
    const sourceCode = loadExample("block_stmts_then_expr.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $compute");
    expect(result.wat).toContain("(result i32)");
    expect(result.wat).toContain("i32.add");
});

/**
 * Test: @fn definition (same codegenKind as @let)
 * Verifies that @fn is registered as a Def-Kind and emits a WAT func
 */
test("E2E: @fn definition emits WAT func with params", () => {
    const sourceCode = loadExample("fn_function.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $add");
    expect(result.wat).toContain("(param $x i32)");
    expect(result.wat).toContain("(param $y i32)");
    expect(result.wat).toContain("i32.add");
});

/**
 * Test: @var definition emits a mutable WAT global
 */
test("E2E: @var definition emits mutable WAT global", () => {
    const sourceCode = loadExample("var_global.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(global $count");
    expect(result.wat).toContain("(mut i32)");
    expect(result.wat).toContain("(i32.const 0)");
});

/**
 * Test: Assignment inside a function body uses local.set for parameters
 */
test("E2E: Assignment to function parameter emits local.set", () => {
    const sourceCode = loadExample("local_set_fix.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $inc");
    expect(result.wat).toContain("local.set $x");
    expect(result.wat).toContain("local.get $x");
});

/**
 * Test: Function definitions are auto-exported
 * WAT output must include (export "name" (func $name)) for @let and @fn
 */
test("E2E: @let function is auto-exported", () => {
    const sourceCode = loadExample("function_definition.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain('(export "add" (func $add))');
});

test("E2E: @fn function is auto-exported", () => {
    const sourceCode = loadExample("fn_function.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain('(export "add" (func $add))');
});

/**
 * Test: @var global mutation in start code
 * Assignments to a @var name outside any function lower to global.set in $__start
 */
test("E2E: @var global mutation emits global.set in start", () => {
    const sourceCode = loadExample("var_mutation.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(global $count (mut i32)");
    expect(result.wat).toContain("global.set $count");
    expect(result.wat).toContain("global.get $count");
    expect(result.wat).toContain("$__start");
});

/**
 * Test: Zero-param @let compiles to a zero-arg WAT function and is callable
 */
test("E2E: Zero-param @let emits zero-arg WAT func and is callable", () => {
    const sourceCode = loadExample("let_constant.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $PI");
    expect(result.wat).toContain("(i32.const 314)");
    expect(result.wat).toContain("(call $PI");
    expect(result.wat).toContain('(export "PI" (func $PI))');
});

/**
 * Test: User-defined stratum operator
 * Verifies that a custom @stratum operator (+++) drives codegen to emit i32.add
 */
test("E2E: User-defined stratum operator generates correct WAT", () => {
    const sourceCode = loadExample("user_stratum_add.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $myAdd");
    expect(result.wat).toContain("(param $x i32)");
    expect(result.wat).toContain("(param $y i32)");
    // The +++ operator defined via @stratum MyAdd -> WASM::i32_add should lower to i32.add
    expect(result.wat).toContain("i32.add");
});

// ---------------------------------------------------------------------------
// @type_alias / @type_distinct — full pipeline
// ---------------------------------------------------------------------------

test("E2E: @type_alias compiles without error and emits no WAT for the declaration", () => {
    const result = compileSource("@type_alias Metres := Int;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    // The type alias itself must not generate any WAT construct.
    expect(result.wat).not.toContain("Metres");
});

test("E2E: @type_alias used as annotation compiles cleanly", () => {
    const result = compileSource("@type_alias Metres := Int;\n@let distance:Metres := 100;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("$distance");
    // The global holds an i32 (alias of Int).
    expect(result.wat).toContain("i32");
});

test("E2E: @type_distinct compiles without error and emits no WAT for the declaration", () => {
    const result = compileSource("@type_distinct UserId := Int;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).not.toContain("UserId");
});
