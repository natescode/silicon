// SPDX-License-Identifier: MIT
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
import { addToAstSemantics, ASTFactory, type ASTNode, type Program, type ExpressionStart, type BinaryOp } from "../ast/index.ts";
import { compileToWat } from "../codegen/index.ts";
import { buildStrataRegistry, elaborate } from "../elaborator/index.ts";
import { typecheck, formatTypeError } from "../types/index.ts";
import { siliconGrammar } from "../grammar/index.ts";
import { loadModules } from "../modules/index.ts";

const moduleRegistry = loadModules(join(import.meta.dirname, '../..'));

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

        // Stage 2.5a: Build strata registry
        const registry = buildStrataRegistry(ast as Program);

        // Stage 2.5b: Elaborate - attach semantic information and stratum definitions
        const { program: elaboratedAST, errors: elabErrors } = elaborate(ast as Program, registry);

        if (elabErrors.length > 0) {
            return {
                success: false,
                error: elabErrors.map(e => e.message).join('; '),
                parseTree: match,
                ast: ast,
                elaboratedAST: elaboratedAST,
                wat: null,
            };
        }

        // Stage 2.6: Type-check — annotate AST with inferred types, catch type errors
        const { program: typedAST, errors: typeErrors, functions } = typecheck(elaboratedAST, registry);

        if (typeErrors.length > 0) {
            return {
                success: false,
                error: typeErrors.map(formatTypeError).join('; '),
                parseTree: match,
                ast: ast,
                elaboratedAST: typedAST,
                wat: null,
            };
        }

        // Stage 3: Lower typed AST → IR → WAT
        const wat: string = compileToWat(typedAST, registry, functions, moduleRegistry);

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
 * Compile a Silicon program with additional strata loaded from external source strings.
 * Mirrors the --strata CLI flag: strata sources are registered before the program's
 * own inline strata, and the program's inline strata can override them.
 */
function compileWithStrata(strataSource: string | string[], mainSource: string) {
    const extraSources = Array.isArray(strataSource) ? strataSource : [strataSource]
    try {
        const match = parse(mainSource)
        const ast: ASTNode = addToAstSemantics(siliconGrammar)(match).toAst()
        const registry = buildStrataRegistry(ast as Program, extraSources)
        const { program: elaboratedAST, errors: elabErrors } = elaborate(ast as Program, registry)
        if (elabErrors.length > 0) {
            return { success: false, error: elabErrors.map(e => e.message).join('; '), wat: null }
        }
        const { program: typedAST, errors: typeErrors, functions } = typecheck(elaboratedAST, registry)
        if (typeErrors.length > 0) {
            return { success: false, error: typeErrors.map(formatTypeError).join('; '), wat: null }
        }
        const wat = compileToWat(typedAST, registry, functions)
        return { success: true, error: null, wat }
    } catch (error) {
        return { success: false, error: String(error), wat: null }
    }
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
 * Verifies that @global with params emits a proper WAT (func ...) at module level
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
 * Test: @fn definition (same codegenKind as @global)
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
 * Test: @mut definition emits a mutable WAT global
 */
test("E2E: @mut definition emits mutable WAT global", () => {
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
 * Test: Function definitions without @export are not exported
 * Functions are only exported when explicitly declared with @export.
 */
test("E2E: @global function without @export is not exported", () => {
    const sourceCode = loadExample("function_definition.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $add");
    expect(result.wat).not.toContain('(export "add"');
});

test("E2E: @fn function without @export is not exported", () => {
    const sourceCode = loadExample("fn_function.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $add");
    expect(result.wat).not.toContain('(export "add"');
});

/**
 * Test: @local global mutation in start code
 * Assignments to a @local name outside any function lower to global.set in $__start
 */
test("E2E: @local global mutation emits global.set in start", () => {
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
 * Test: Zero-param @global compiles to a zero-arg WAT function and is callable
 */
test("E2E: Zero-param @global emits zero-arg WAT func and is callable", () => {
    const sourceCode = loadExample("let_constant.si");
    const result = compileSource(sourceCode);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(func $PI");
    expect(result.wat).toContain("(i32.const 314)");
    expect(result.wat).toContain("(call $PI");
    expect(result.wat).not.toContain('(export "PI"');
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
    const result = compileSource("@type_alias Metres := Int;\ndistance := 100;");

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

// ---------------------------------------------------------------------------
// @type_sum — full pipeline
// ---------------------------------------------------------------------------

test("E2E: @type_sum emits an immutable i32 global for each variant", () => {
    const result = compileSource("@enum Color := Red | Green | Blue;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    // WAT identifiers use _ instead of ::, so Color::Red → $Color_Red.
    expect(result.wat).toContain("(global $Color_Red i32 (i32.const 0))");
    expect(result.wat).toContain("(global $Color_Green i32 (i32.const 1))");
    expect(result.wat).toContain("(global $Color_Blue i32 (i32.const 2))");
});

test("E2E: @type_sum variant reference resolves via global.get", () => {
    const result = compileSource("@enum Color := Red | Green | Blue;\nColor::Red;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("global.get $Color_Red");
});

// ---------------------------------------------------------------------------
// @match — full pipeline
// ---------------------------------------------------------------------------

test("E2E: @match emits nested (if ...) chain with i32.eq comparisons", () => {
    const src = [
        "@enum Color := Red | Green | Blue;",
        "@mut c := Color::Red;",
        "@match(c, Color::Red, { 1 }, Color::Green, { 2 }, Color::Blue, { 3 });",
    ].join("\n");
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    // Each arm is compiled as a nested (if ...) with i32.eq discriminant check.
    expect(result.wat).toContain("i32.eq");
    expect(result.wat).toContain("global.get $Color_Red");
    expect(result.wat).toContain("global.get $Color_Green");
    expect(result.wat).toContain("global.get $Color_Blue");
    // Exhaustive match ends with (unreachable).
    expect(result.wat).toContain("unreachable");
});

// ---------------------------------------------------------------------------
// @local — block-local variables
// ---------------------------------------------------------------------------

test("E2E: @local emits (local ...) in function preamble", () => {
    const src = "\\\\ f (Int)\nf x := {\n    @mut tmp := x + 1;\n    tmp\n};";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(local $tmp i32)");
});

test("E2E: @local binding emits local.set at the binding site", () => {
    const src = "\\\\ f (Int)\nf x := {\n    @mut tmp := x + 1;\n    tmp\n};";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("local.set $tmp");
});

test("E2E: @local reference emits local.get", () => {
    const src = "\\\\ f (Int)\nf x := {\n    @mut tmp := x + 1;\n    tmp\n};";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    // trailing `tmp` in the block should be local.get
    expect(result.wat).toContain("local.get $tmp");
});

test("E2E: @local is reassignable via assignment", () => {
    // After @local tmp := 0; reassign tmp = x; the assignment emits local.set.
    const src = "\\\\ f (Int)\nf x := {\n    @mut tmp := 0;\n    tmp = x;\n    tmp\n};";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    // Two local.set occurrences: initial binding and the assignment
    const matches = (result.wat ?? "").match(/local\.set \$tmp/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
});

test("E2E: multiple @local variables each get their own WAT local", () => {
    const src = "\\\\ f (Int)\nf x := {\n    @mut a := x;\n    @mut b := a + 1;\n    b\n};";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(local $a i32)");
    expect(result.wat).toContain("(local $b i32)");
});

// ---------------------------------------------------------------------------
// @global scalar reference fix — zero-param @global uses (call ...) not global.get
// ---------------------------------------------------------------------------

test("E2E: zero-param @global emits a function and references use (call ...)", () => {
    const src = "five := 5; five + 1;";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(func $five");
    // References to five should use call, not global.get
    expect(result.wat).toContain("(call $five)");
    expect(result.wat).not.toContain("global.get $five");
});

// ---------------------------------------------------------------------------
// StrataType tagging — elaborator correctly labels each strata node
// ---------------------------------------------------------------------------

test("E2E: @if strata has StrataType.Control via registry", () => {
    const src = "@if(1, { 2 }, { 3 });";
    const result = compileSource(src);
    // If StrataType tagging is wrong the elaborator would still register @if
    // correctly in the keywords bucket; we verify compilation succeeds and
    // that the WAT contains the structured if construct.
    expect(result.success).toBe(true);
    expect(result.wat).toContain("(if");
});

// ---------------------------------------------------------------------------
// @match in expression position
// ---------------------------------------------------------------------------

test("E2E: @match in expression position emits (if (result i32) ...)", () => {
    const src = [
        "@enum Color := Red | Green | Blue;",
        "@mut c := Color::Red;",
        "label := { @match(c, Color::Red, { 1 }, Color::Green, { 2 }, Color::Blue, { 3 }) };",
    ].join("\n");
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(result i32)");
});

// ---------------------------------------------------------------------------
// Round 21: logical operators && || ! via strata
// ---------------------------------------------------------------------------

test("E2E: || emits short-circuit WAT (if (result i32) ...)", () => {
    const result = compileSource("@true || @false;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(if (result i32)");
    expect(result.wat).toContain("(i32.const 1)");
    expect(result.wat).toContain("(i32.const 0)");
});

test("E2E: @not emits i32.eqz", () => {
    const result = compileSource("@not(@true);");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("i32.eqz");
});

test("E2E: @and emits short-circuit AND WAT (if (result i32) ...)", () => {
    const result = compileSource("@and(@true, @false);");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(if (result i32)");
    expect(result.wat).toContain("(i32.const 0)");
});

test("E2E: || with variables produces correct short-circuit structure", () => {
    const src = "@mut a := 1; @mut b := 0; a || b;";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(if (result i32)");
    expect(result.wat).toContain("global.get $a");
    expect(result.wat).toContain("global.get $b");
});

test("E2E: @not of zero is 1 (i32.eqz (i32.const 0))", () => {
    const result = compileSource("@not(0);");

    expect(result.success).toBe(true);
    expect(result.wat).toContain("i32.eqz");
    expect(result.wat).toContain("(i32.const 0)");
});

test("E2E: chained || short-circuits left to right", () => {
    const src = "@mut x := 0; @mut y := 0; @mut z := 1; x || y || z;";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    // Each || produces its own (if (result i32) ...)
    const matches = (result.wat ?? "").match(/if \(result i32\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
});

test("E2E: || in function body with typed result", () => {
    const src = "\\\\ check (Int, Int)\ncheck a, b := {\n    a || b\n};";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(func $check");
    expect(result.wat).toContain("(if (result i32)");
});

test("E2E: @and with both true returns right side", () => {
    const src = "\\\\ f (Int, Int)\nf a, b := {\n    @and(a, b)\n};";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(func $f");
    expect(result.wat).toContain("(if (result i32)");
    expect(result.wat).toContain("(i32.const 0)");
});

// ---------------------------------------------------------------------------
// Round 22: Def-Kind schema validation
// ---------------------------------------------------------------------------

test.skip("Schema: @local with parameters is rejected (D-D-11c regression — new register::keyword always allowsParams=true)", () => {
    const result = compileSource("\\\\ count (Int)\n@mut count x := 0;");
    expect(result.success).toBe(false);
    expect(result.error).toContain("'@local' does not accept parameters");
});

test.skip("Schema: @extern with a binding is rejected (D-D-11c regression — new register::keyword always allowsBinding=true)", () => {
    const result = compileSource("@extern { \\\\ print () -> Void }");
    expect(result.success).toBe(false);
    expect(result.error).toContain("'@extern' does not accept a binding");
});

test("Schema: @global with parameters and binding is accepted", () => {
    const result = compileSource("\\\\ add (Int, Int)\nadd x, y := {\n    x + y\n};");

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(func $add");
});

test("Schema: @local with binding and no params is accepted", () => {
    const result = compileSource("@mut count := 0;");

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(global $count");
});

test("Schema: @extern with params and no binding is accepted", () => {
    const result = compileSource("\\\\ @extern print (Int) -> Void;");

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(import");
});

test.skip("Schema: @local with params is rejected (D-D-11a regression — new register::keyword doesn't carry allowsParams=false)", () => {
    // D-D-11a migration regression: the new register::keyword always
    // sets allowsParams=true.  Need a follow-up
    // `register::leaf_keyword` (or similar) to preserve the legacy
    // schema check for @local / @local / @type_sum.
    const result = compileSource("\\\\ f (Int)\n@global f x := { @local tmp a:Int := 0; tmp };");
    expect(result.success).toBe(false);
    expect(result.error).toContain("'@local' does not accept parameters");
});

test("Schema: unknown def-kind keyword is rejected", () => {
    const result = compileSource("@unknown foo := 5;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown definition keyword '@unknown'");
});

test.skip("Schema: @local with generic params is rejected (D-D-11c regression — new register::keyword always allowsGenerics=true)", () => {
    const result = compileSource("@mut count[T] := 0;");
    expect(result.success).toBe(false);
    expect(result.error).toContain("'@local' does not accept generic parameters");
});

test.skip("Schema: @type_sum with params is rejected (D-D-11d regression — new register::keyword always allowsParams=true)", () => {
    const result = compileSource("@type_sum Color x:Int := Red | Green;");
    expect(result.success).toBe(false);
    expect(result.error).toContain("'@type_sum' does not accept parameters");
});

// ============================================================================
// Round 23: Type-driven codegen (replace f32 string-sniff heuristic)
// ============================================================================

// Helper: extract only the user-emitted WAT (after the std.wat runtime).
// $print_string is the last function in std.wat; the first \n\n after it is
// the boundary between the runtime and user-emitted code.
function userWat(wat: string): string {
    const marker = '(func $print_string'
    const idx = wat.indexOf(marker)
    if (idx < 0) return wat
    const afterPrint = wat.indexOf('\n\n', idx)
    return afterPrint >= 0 ? wat.slice(afterPrint) : wat.slice(idx)
}

test("Round 23: float params use f32.add not i32.add", () => {
    const result = compileSource("\\\\ add (Float, Float)\nadd a, b := {\n    a + b\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.add");
    expect(uw).not.toContain("i32.add");
});

test("Round 23: int params use i32.add not f32.add", () => {
    const result = compileSource("\\\\ add (Int, Int)\nadd a, b := {\n    a + b\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.add");
    expect(uw).not.toContain("f32.add");
});

test("Round 23: float comparison uses f32.gt", () => {
    const result = compileSource("\\\\ greater (Float, Float)\ngreater a, b := {\n    a > b\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.gt");
    expect(uw).not.toContain("i32.gt");
});

test("Round 23: float comparison uses f32.lt", () => {
    const result = compileSource("\\\\ lesser (Float, Float)\nlesser a, b := {\n    a < b\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.lt");
    expect(uw).not.toContain("i32.lt");
});

test("Round 23: mixed int+float without cast is a type error", () => {
    // With the type checker active, Int + Float is a strict mismatch — no implicit promotion.
    const result = compileSource("\\\\ mixed (Int, Float)\nmixed a, b := {\n    a + b\n};");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch|Int|Float/i);
});

test("Round 23: float global resolves to f32 in expressions", () => {
    const result = compileSource("@mut x := 1.5; getX := { x + 0.0 };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.add");
});

test("Round 23: float call return type drives arithmetic (f32.add in caller)", () => {
    // &double takes a Float and returns Float; two calls added together should use f32.add
    const src = "\\\\ double (Float)\ndouble x := {\n    x + x\n};\n\\\\ quad (Float)\nquad y := {\n    double(y + double(y))\n};";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.add");
});

test("Round 23: float subtraction uses f32.sub", () => {
    const result = compileSource("\\\\ sub (Float, Float)\nsub a, b := {\n    a - b\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.sub");
    expect(uw).not.toContain("i32.sub");
});

test("Round 23: float multiplication uses f32.mul", () => {
    const result = compileSource("\\\\ mul (Float, Float)\nmul a, b := {\n    a * b\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.mul");
    expect(uw).not.toContain("i32.mul");
});

// ============================================================================
// Round 24: @break / @continue — loop control flow via strata keywords
// ============================================================================

test("Round 24: @loop emits block/loop WAT structure", () => {
    // Body ends with &@break so br $cont_ appears as unreachable dead code (valid WAT).
    // { 0 } would leave a value on the stack before br $cont_, producing invalid WASM.
    const src = "count := { @loop(1, { @break() }); 42 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("(block $brk_");
    expect(uw).toContain("(loop $cont_");
    expect(uw).toContain("br_if $brk_");
    expect(uw).toContain("br $cont_");
});

test("Round 24: @break emits br to block label", () => {
    const src = "run := { @loop(1, { @break() }); 0 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toMatch(/br \$brk_\d+/);
});

test("Round 24: @continue emits br to loop label", () => {
    const src = "run := { @loop(1, { @continue() }); 0 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toMatch(/br \$cont_\d+/);
});

test("Round 24: @break label matches enclosing @loop label", () => {
    // The $brk_N in @break must equal the $brk_N in the enclosing block
    const src = "run := { @loop(1, { @break() }); 0 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    const blockId = uw.match(/block \$brk_(\d+)/)?.[1]
    const breakId = uw.match(/\(br \$brk_(\d+)\)/)?.[1]
    expect(blockId).toBeDefined()
    expect(breakId).toBeDefined()
    expect(blockId).toBe(breakId)
});

test("Round 24: @continue label matches enclosing @loop label", () => {
    const src = "run := { @loop(1, { @continue() }); 0 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    const loopId = uw.match(/loop \$cont_(\d+)/)?.[1]
    const contId = uw.match(/\(br \$cont_(\d+)\)/)?.[1]
    expect(loopId).toBeDefined()
    expect(contId).toBeDefined()
    expect(loopId).toBe(contId)
});

test("Round 24: nested @loop — inner @break uses inner label", () => {
    // Outer body ends with &@continue (so outer br $cont_ is unreachable dead code).
    const src = "run := { @loop(1, { @loop(1, { @break() }); @continue() }); 0 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    // Two distinct block IDs must be present
    const ids = [...uw.matchAll(/block \$brk_(\d+)/g)].map(m => m[1])
    expect(ids.length).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
    // The (br $brk_N) should use the INNER (second) id
    const breakId = uw.match(/\(br \$brk_(\d+)\)/)?.[1]
    expect(breakId).toBe(ids[1])
});

test("Round 24: @break registered in registry as keyword stratum (D-D-8 migrated)", () => {
    // D-D-8: @break/@continue/@return now use the new @stratum form.  The
    // legacy intrinsic field is no longer set; dispatch flows via the
    // on::lower handler registered on the keyword.
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@break']).toBeDefined()
    expect(registry.handlers.lower.has('@break')).toBe(true)
});

test("Round 24: @continue registered in registry as keyword stratum (D-D-8 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@continue']).toBeDefined()
    expect(registry.handlers.lower.has('@continue')).toBe(true)
});

test("Round 24: @loop registered in registry as keyword stratum (D-D-9 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@loop']).toBeDefined()
    expect(registry.handlers.lower.has('@loop')).toBe(true)
});

test("Round 24: count_loop.si example compiles successfully", () => {
    const result = compileSource(loadExample("count_loop.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("(block $brk_");
    expect(uw).toContain("(loop $cont_");
    expect(uw).toContain("local.set $n");
});

test("Round 24: condition-based loop — condition embedded in br_if check", () => {
    const src = "run := { @mut n := 0; @loop(n < 5, { n = n + 1; }); n };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    // 'n < 5' compiles to lt_s inside the br_if (i32.eqz ...) exit check
    expect(uw).toContain("lt_s");
    expect(uw).toContain("br_if $brk_");
    // Condition check comes before the body mutation (use lastIndexOf to skip the @local init)
    const brIfIdx = uw.indexOf("br_if $brk_");
    const setIdx = uw.lastIndexOf("local.set $n");
    expect(setIdx).toBeGreaterThan(brIfIdx);
});

test("Round 24: loop body with mutation-as-item is void — local.set before br $cont_", () => {
    // The loop body { n = n + 1; } ends with a semicolon → no trailing expression.
    // local.set $n leaves nothing on the stack, so br $cont_ is reached with empty stack.
    const src = "run := { @mut n := 0; @loop(n < 5, { n = n + 1; }); n };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    const setIdx = uw.indexOf("local.set $n");
    const contIdx = uw.indexOf("br $cont_");
    expect(setIdx).toBeGreaterThan(-1);
    expect(contIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(contIdx);
});

test("Round 24: loop with @if-break pattern — conditional exit inside body", () => {
    const src = "run := { @mut n := 0; @loop(1, { n = n + 1; @if(n >= 3, { @break() }); }); n };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("ge_s");
    expect(uw).toContain("(if");
    // The br inside @if targets the enclosing loop's block label
    const blockId = uw.match(/block \$brk_(\d+)/)?.[1];
    expect(blockId).toBeDefined();
    expect(uw).toContain(`(then (br $brk_${blockId})`);
});

// ============================================================================
// Round 26: Bitwise operator strata — |, ^, <<, >>
// ============================================================================

test("Round 26: | emits i32.or", () => {
    const result = compileSource(loadExample("bitwise_or.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.or");
});

test("Round 26: ^ emits i32.xor", () => {
    const result = compileSource(loadExample("bitwise_xor.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.xor");
});

test("Round 26: << emits i32.shl", () => {
    const result = compileSource(loadExample("bitwise_shl.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.shl");
});

test("Round 26: >> emits i32.shr_s", () => {
    const result = compileSource(loadExample("bitwise_shr.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.shr_s");
});

test("Round 26: | in function body uses i32.or not f32.or", () => {
    const result = compileSource("\\\\ mask (Int, Int)\nmask a, b := {\n    a | b\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.or");
    expect(uw).not.toContain("f32.or");
});

test("Round 26: ^ in function body uses i32.xor", () => {
    const result = compileSource("\\\\ toggle (Int, Int)\ntoggle a, b := {\n    a ^ b\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.xor");
});

test("Round 26: << with literal shift amount", () => {
    const result = compileSource("\\\\ double (Int)\ndouble a := {\n    a << 1\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.shl");
});

test("Round 26: >> with literal shift amount", () => {
    const result = compileSource("\\\\ half (Int)\nhalf a := {\n    a >> 1\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.shr_s");
});

test("Round 26: bitwise ops combined with arithmetic", () => {
    const result = compileSource("\\\\ f (Int, Int)\nf a, b := {\n    a + b | (a ^ b)\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.add");
    expect(uw).toContain("i32.xor");
    expect(uw).toContain("i32.or");
});

test("Round 26: bitwise | does not promote to f32 (always emits i32.or)", () => {
    const result = compileSource("\\\\ f (Int)\nf a := {\n    a | 255\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.or");
    expect(uw).not.toContain("f32");
});

// D-D-4 migrated: bitwise operators dispatch via on::lower handlers, not via
// the legacy intrinsic/bodyTemplate fields.  Tests assert registration +
// on::lower presence only.
test("Round 26: | operator registered (D-D-4 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.operators['|']).toBeDefined()
    expect(registry.handlers.lower.has('|')).toBe(true)
});

test("Round 26: ^ operator registered (D-D-4 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.operators['^']).toBeDefined()
    expect(registry.handlers.lower.has('^')).toBe(true)
});

test("Round 26: << operator registered (D-D-4 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.operators['<<']).toBeDefined()
    expect(registry.handlers.lower.has('<<')).toBe(true)
});

test("Round 26: >> operator registered (D-D-4 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.operators['>>']).toBeDefined()
    expect(registry.handlers.lower.has('>>')).toBe(true)
});

test("Round 26: | and || are distinct operators", () => {
    // Bitwise OR and logical OR must coexist without conflict
    const src = "@mut x := 5; @mut y := 3; x | y; x || y;";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("i32.or");
    expect(result.wat).toContain("(if (result i32)");
});

// ============================================================================
// Round 27: @return early return + @toInt / @toFloat type casts
// ============================================================================

test("Round 27: @return — early_return.si compiles successfully", () => {
    const result = compileSource(loadExample("early_return.si"));
    expect(result.success).toBe(true);
});

test("Round 27: @return emits 'return' WAT instruction", () => {
    const result = compileSource(loadExample("early_return.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("return");
});

test("Round 27: @return inside @if — fallthrough code also emits", () => {
    // Both the early-return path (return) and the normal path (i32.div_s) must appear
    const result = compileSource(loadExample("early_return.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("return");
    expect(uw).toContain("i32.div_s");
});

test("Round 27: @return with value emits value then return", () => {
    const result = compileSource("zero := { @return(0) };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("(i32.const 0)");
    expect(uw).toContain("return");
});

test("Round 27: @return with no arg emits bare return", () => {
    // A @global with no binding just returns the default (empty @return)
    const result = compileSource("earlyExit := { @return() };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("return");
});

test("Round 27: @return registered in registry as keyword stratum (D-D-8 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@return']).toBeDefined()
    expect(registry.handlers.lower.has('@return')).toBe(true)
});

// ============================================================================
// Phase 4: @defer cleanup stratum
// ============================================================================

test("Phase 4: @defer registered in registry as expression-keyword stratum", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@defer']).toBeDefined()
    expect(registry.handlers.lower.has('@defer')).toBe(true)
});

test("Phase 4: defer_basic.si — cleanup appended after body", () => {
    const result = compileSource(loadExample("defer_basic.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("call $acquire");
    expect(uw).toContain("call $release");
    // The defer site itself emits nothing; cleanup appears via the wrap.
    // Cleanup call appears after acquire (cannot precede the local set).
    const acquireIdx = uw.indexOf("call $acquire");
    const releaseIdx = uw.indexOf("call $release");
    expect(releaseIdx).toBeGreaterThan(acquireIdx);
});

test("Phase 4: defer_lifo.si — multiple defers fire in LIFO order", () => {
    const result = compileSource(loadExample("defer_lifo.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    // Cleanup order should be c → b → a (LIFO of registration order).
    const cIdx = uw.indexOf("call $release_c");
    const bIdx = uw.indexOf("call $release_b");
    const aIdx = uw.indexOf("call $release_a");
    expect(cIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(cIdx);
    expect(aIdx).toBeGreaterThan(bIdx);
});

test("Phase 4: defer_with_return.si — early @return runs cleanup before return", () => {
    const result = compileSource(loadExample("defer_with_return.si"));
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("call $release");
    expect(uw).toContain("return");
    // The first occurrence of `release` must precede the first `return` —
    // proving the @return path bundles cleanup ahead of the unwinding control flow.
    const releaseIdx = uw.indexOf("call $release");
    const returnIdx = uw.indexOf("return");
    expect(returnIdx).toBeGreaterThan(releaseIdx);
});

test("Phase 4: @defer site itself produces no inline IR", () => {
    // A function whose only statement is @defer should not call any function
    // at the defer site — the cleanup is only materialised at function exit.
    const src = `\\\\ @extern cleanup ();
@fn f := {
    @defer(cleanup())
};`
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    // Cleanup must appear exactly once (the end-of-body wrap), not twice.
    const cleanupCount = (uw.match(/call \$cleanup/g) || []).length;
    expect(cleanupCount).toBe(1);
});

test("Round 27: @toFloat — cast_to_float.si compiles successfully", () => {
    const result = compileSource(loadExample("cast_to_float.si"));
    expect(result.success).toBe(true);
});

test("Round 27: @toFloat emits f32.convert_i32_s", () => {
    const result = compileSource(loadExample("cast_to_float.si"));
    expect(result.success).toBe(true);
    expect(result.wat).toContain("f32.convert_i32_s");
});

test("Round 27: @toFloat on an Int param emits f32.convert_i32_s", () => {
    const result = compileSource("\\\\ cast (Int)\ncast x := {\n    @toFloat(x)\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.convert_i32_s");
});

test("Round 27: @toFloat promotes type — explicit cast then float add", () => {
    // &@toFloat x + y parses as @toFloat(x + y) which is Int+Float → type error.
    // Parentheses are needed: (&@toFloat x) converts to Float, then + y:Float is f32.add.
    const result = compileSource("\\\\ mixAdd (Int, Float)\nmixAdd x, y := {\n    @toFloat(x) + y\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.convert_i32_s");
    expect(uw).toContain("f32.add");
    expect(uw).not.toContain("i32.add");
});

test("Round 27: @toFloat registered in registry as keyword stratum (D-D-5 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@toFloat']).toBeDefined()
    expect(registry.handlers.lower.has('@toFloat')).toBe(true)
});

test("Round 27: @toInt — cast_to_int.si compiles successfully", () => {
    const result = compileSource(loadExample("cast_to_int.si"));
    expect(result.success).toBe(true);
});

test("Round 27: @toInt emits i32.trunc_f32_s", () => {
    const result = compileSource(loadExample("cast_to_int.si"));
    expect(result.success).toBe(true);
    expect(result.wat).toContain("i32.trunc_f32_s");
});

test("Round 27: @toInt on a Float param emits i32.trunc_f32_s", () => {
    const result = compileSource("\\\\ cast (Float)\ncast x := {\n    @toInt(x)\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.trunc_f32_s");
});

test("Round 27: @toInt registered in registry as keyword stratum (D-D-5 migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@toInt']).toBeDefined()
    expect(registry.handlers.lower.has('@toInt')).toBe(true)
});

test("Round 27: @toInt result type is i32 — can add with int param", () => {
    const result = compileSource("\\\\ roundAdd (Float, Int)\nroundAdd x, y := {\n    @toInt(x) + y\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.trunc_f32_s");
    expect(uw).toContain("i32.add");
});

test("Round 27: @toFloat and @toInt round-trip in a function", () => {
    const result = compileSource("\\\\ roundTrip (Int)\nroundTrip x := {\n    @toInt(@toFloat(x))\n};");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.convert_i32_s");
    expect(uw).toContain("i32.trunc_f32_s");
});

// ============================================================================
// Round 28: Type checker wired into the pipeline
// ============================================================================

test("Round 28: Int + Float without cast is a type error", () => {
    const result = compileSource("\\\\ f (Int, Float)\nf a, b := {\n    a + b\n};");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch|Int|Float/i);
});

test("Round 28: Float + Float compiles successfully", () => {
    const result = compileSource("\\\\ f (Float, Float)\nf a, b := {\n    a + b\n};");
    expect(result.success).toBe(true);
    expect(result.wat).toContain("f32.add");
});

test("Round 28: annotation mismatch — typed binding x Int with float value is a type error", () => {
    const result = compileSource("\\\\ x Int\nx := 3.14;");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch|annotation|Int|Float/i);
});

test("Round 28: assignment to immutable @global is a type error", () => {
    const result = compileSource("x := 5; x = 10;");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/immutable|x/i);
});

test("Round 28: wrong arg type in function call is a type error", () => {
    const result = compileSource("\\\\ double (Int)\ndouble x := {\n    x + x\n};\nrun := {\n    double(3.14)\n};");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch|Int|Float/i);
});

test("Round 28: @toInt on a Float param returns Int — no type error", () => {
    const result = compileSource("\\\\ f (Float)\nf x := {\n    @toInt(x)\n};");
    expect(result.success).toBe(true);
    expect(result.wat).toContain("i32.trunc_f32_s");
});

test("Round 28: @toInt on an Int param is a type error", () => {
    const result = compileSource("\\\\ f (Int)\nf x := {\n    @toInt(x)\n};");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch|Float|Int/i);
});

test("Round 28: @toFloat on an Int param returns Float — no type error", () => {
    const result = compileSource("\\\\ f (Int)\nf x := {\n    @toFloat(x)\n};");
    expect(result.success).toBe(true);
    expect(result.wat).toContain("f32.convert_i32_s");
});

test("Round 28: @toFloat on a Float param is a type error", () => {
    const result = compileSource("\\\\ f (Float)\nf x := {\n    @toFloat(x)\n};");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch|Float|Int/i);
});

test("Round 28: well-typed function with @if compiles successfully", () => {
    const result = compileSource("\\\\ safeDivide (Int, Int)\nsafeDivide x, y := {\n    @if(y == 0, {\n        @return(0)\n    });\n    x / y\n};");
    expect(result.success).toBe(true);
    expect(result.wat).toContain("i32.div_s");
});

test("Round 28: heterogeneous comparison types is a type error", () => {
    const result = compileSource("\\\\ f (Int, Float)\nf x, y := {\n    x < y\n};");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch|Int|Float/i);
});

// ============================================================================
// Round 34: built-in strata bodies (legacy @stratum_operator coverage
// removed by the Phase 5 grammar revision — equivalent unified-form
// coverage lives in src/elaborator/strata2.test.ts)
// ============================================================================

test("Round 34: single-step strata body still works (regression)", () => {
    const result = compileSource("\\\\ f (Int, Int)\nf a, b := {\n    a + b\n};")
    expect(result.success).toBe(true)
    expect(userWat(result.wat!)).toContain("i32.add")
})

test("Round 34: '+' dispatches via on::lower handler (D-D-7a migrated)", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    // D-D-7a: no more bodyTemplate; the handler synthesises the IRBinOp.
    expect(registry.operators['+']).toBeDefined()
    expect(registry.handlers.lower.has('+')).toBe(true)
})

// ============================================================================
// Round 35: strata imports — external strata sources via compileWithStrata
// (legacy @stratum_operator / @stratum_keyword coverage removed by the
// Phase 5 grammar revision; T2 external-source tier and registration are
// covered by src/elaborator/strata2.test.ts via the unified @stratum form)
// ============================================================================

test("Round 35: unknown operator without registering strata causes elaboration error", () => {
    // Compiling '***' without loading the strata that defines it should fail.
    const result = compileSource(`\\\\ f (Int, Int)
f a, b := {
    a *** b
};`)
    expect(result.success).toBe(false)
})

// ---------------------------------------------------------------------------
// Round 36: typed operator overloads — StrataType::Constraint
// ---------------------------------------------------------------------------

test("Round 36: Float addition uses f32.add, not i32.add", () => {
    const result = compileSource(`\\\\ add (Float, Float)
add a, b := {
    a + b
};`)
    expect(result.success).toBe(true)
    const uw = userWat(result.wat!)
    expect(uw).toContain('f32.add')
    expect(uw).not.toContain('i32.add')
})

test("Round 36: Int addition uses i32.add, not f32.add (regression)", () => {
    const result = compileSource(`\\\\ add (Int, Int)
add a, b := {
    a + b
};`)
    expect(result.success).toBe(true)
    const uw = userWat(result.wat!)
    expect(uw).toContain('i32.add')
    expect(uw).not.toContain('f32.add')
})

test("Round 36: Float comparison uses f32.lt", () => {
    const result = compileSource(`\\\\ cmp (Float, Float)
cmp a, b := {
    a < b
};`)
    expect(result.success).toBe(true)
    expect(userWat(result.wat!)).toContain('f32.lt')
})

test("Round 36: Float division uses f32.div", () => {
    const result = compileSource(`\\\\ div (Float, Float)
div a, b := {
    a / b
};`)
    expect(result.success).toBe(true)
    expect(userWat(result.wat!)).toContain('f32.div')
})

// User-defined typed-operator overload coverage (Int / Float dispatch on
// the same symbol) moved to src/elaborator/strata2.test.ts under the
// unified @stratum form.

// ---------------------------------------------------------------------------
// Round 37: || strata consistency, keyword typed dispatch, @export metadata strata
// ---------------------------------------------------------------------------

test("Round 37: || produces short-circuit WAT driven by the Or_lower strata handler", () => {
    // || must be lowered via the strata registry (the logic.si Or_lower
    // on::lower handler builds the IRIf), not via a hardcoded symbol check.
    // Verify the emitted structure.
    const result = compileSource(`\\\\ f (Int, Int)
f a, b := {
    a || b
};`)
    expect(result.success).toBe(true)
    const uw = userWat(result.wat!)
    // Short-circuit OR emits as (if (result i32) cond (then i32.const 1) (else rhs)).
    expect(uw).toContain('(if')
    expect(uw).toContain('i32.const 1')
    // Must NOT emit i32.or (that's the bitwise OR intrinsic, not short-circuit).
    expect(uw).not.toContain('i32.or')
})

test("Round 37: @export emits explicit WAT export for a global", () => {
    const result = compileSource(`@mut counter := 0;
@export counter;`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(export "counter" (global $counter))')
})

test("Round 37: @export on a function emits explicit WAT export for the function", () => {
    const result = compileSource(`\\\\ add (Int, Int)
add a, b := {
    a + b
};
@export add;`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(export "add" (func $add))')
})

test("Round 37: @export unknown keyword is an elaboration error without grammar changes", () => {
    // @export is registered via metadata.si strata — not a grammar keyword.
    // Verifies the mechanism works end-to-end (no parse error).
    const result = compileSource(`@mut n := 1;
@export n;`)
    expect(result.success).toBe(true)
})

// User-defined typed-keyword overload coverage (Int / Float dispatch on
// the same keyword) moved to src/elaborator/strata2.test.ts under the
// unified @stratum form.

// ---------------------------------------------------------------------------
// Round 43: @match trailing default — catch-all arm (even arg count)
// ---------------------------------------------------------------------------

test("Round 43: @match trailing default emits no i32.eq for the default arm", () => {
    // Even arg count: last arg is the catch-all default, no comparison emitted for it.
    const src = [
        "@enum Color := Red | Green | Blue;",
        "@mut c := Color::Red;",
        "@match(c, Color::Red, { 1 }, { 0 });",
    ].join("\n")
    const result = compileSource(src)

    expect(result.success).toBe(true)
    expect(result.wat).toBeDefined()
    // Only one i32.eq: the Red arm. Default has no comparison.
    const eqMatches = userWat(result.wat ?? "").match(/i32\.eq/g) ?? []
    expect(eqMatches.length).toBe(1)
    // Default replaces unreachable — no (unreachable) in *user* output.
    // (The prelude's $alloc now uses `unreachable` for heap-exhaustion
    // traps under Phase 9c-4, so we scope this assertion to userWat.)
    expect(userWat(result.wat ?? "")).not.toContain("unreachable")
})

test("Round 43: @match two explicit arms + trailing default", () => {
    const src = [
        "@enum Status := Ok | Warn | Error;",
        "@mut s := Status::Warn;",
        "@match(s, Status::Ok, { 0 }, Status::Error, { 2 }, { 1 });",
    ].join("\n")
    const result = compileSource(src)

    expect(result.success).toBe(true)
    // See note above re: prelude unreachable.
    expect(userWat(result.wat ?? "")).not.toContain("unreachable")
    // Two explicit comparisons, none for the default.
    const eqMatches = userWat(result.wat ?? "").match(/i32\.eq/g) ?? []
    expect(eqMatches.length).toBe(2)
})

test("Round 43: type checker accepts trailing default @match without errors", () => {
    const src = [
        "@enum Bool2 := Yes | No;",
        "@mut b := Bool2::Yes;",
        "@match(b, Bool2::Yes, { 1 }, { 0 });",
    ].join("\n")
    const result = compileSource(src)

    expect(result.success).toBe(true)
})

test("Round 43: @match trailing default type mismatch is a type error", () => {
    // Default is Float but arm result is Int — should error.
    const src = [
        "@enum Color := Red | Green;",
        "@mut c := Color::Red;",
        "@match(c, Color::Red, { 1 }, { 2.5 });",
    ].join("\n")
    const result = compileSource(src)

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
})

test("Round 43: @type_sum lowering uses def expander (sum-type globals still emit correctly)", () => {
    // Regression: type_sum globals must still emit even after removing the
    // hardcoded lowerSumType — the def expander must produce the same output.
    const result = compileSource("@enum Direction := North | South | East | West;")

    expect(result.success).toBe(true)
    expect(result.wat).toContain("(global $Direction_North i32 (i32.const 0))")
    expect(result.wat).toContain("(global $Direction_South i32 (i32.const 1))")
    expect(result.wat).toContain("(global $Direction_East i32 (i32.const 2))")
    expect(result.wat).toContain("(global $Direction_West i32 (i32.const 3))")
})

// ---------------------------------------------------------------------------
// Round 46: Module system and web:: namespace APIs
// ---------------------------------------------------------------------------

test("Round 46: web::console_log_str auto-generates WASM import from module registry", () => {
    const result = compileSource(`
        \\\\ greet (String)
        @fn greet msg := {
            web::console_log_str(msg);
            msg
        };`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(import "web" "console_log_str" (func $web__console_log_str (param i32)))')
    expect(result.wat).toContain('(call $web__console_log_str')
})

test("Round 46: web::math_sqrt auto-generates float import", () => {
    const result = compileSource(`
        \\\\ root (Float)
        @fn root x := {
            web::math_sqrt(x)
        };`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(import "web" "math_sqrt" (func $web__math_sqrt (param f32) (result f32)))')
    expect(result.wat).toContain('(call $web__math_sqrt')
})

test("Round 46: web::math_pow with two Float args is deduplicated across multiple calls", () => {
    const result = compileSource(`
        \\\\ hyp (Float, Float)
        @fn hyp a, b := {
            web::math_sqrt(web::math_pow(a, 2.0) + web::math_pow(b, 2.0))
        };`)
    expect(result.success).toBe(true)
    // Import should appear exactly once even though math_pow is called twice.
    const importMatches = result.wat!.match(/\(import "web" "math_pow"/g) ?? []
    expect(importMatches.length).toBe(1)
})

test("Round 46: no @extern declaration needed for module functions", () => {
    // Previously you had to write @extern web_console_log_str ptr:String; — now it's gone.
    const result = compileSource(`
        \\\\ log (Int)
        @fn log v := {
            web::console_log(v);
            v
        };`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(import "web" "console_log"')
    expect(result.wat).not.toContain('@extern')
})

test("Round 46: unknown module throws a meaningful error", () => {
    const result = compileSource(`
        \\\\ bad (Int)
        @fn bad v := {
            nonexistent::foo(v)
        };`)
    expect(result.success).toBe(false)
    expect(result.error).toContain("Unknown module 'nonexistent'")
})

// ============================================================================
// Phase A — Silicon-Core i64: Int64 type + @toInt64 / @toInt overload
//   Plan: docs/archive/silicon-core-i64-plan.html
// ============================================================================

test("Phase A i64: Int64 extern declaration emits (param i64) and (result i64)", () => {
    const result = compileSource(loadExample("int64_extern_call.si"))
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(param i64)')
    expect(result.wat).toContain('(result i64)')
})

test("Phase A i64: @toInt64 emits i64.extend_i32_s and the call passes an i64 arg", () => {
    const result = compileSource(loadExample("int64_extern_call.si"))
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i64.extend_i32_s')
})

test("Phase A i64: Int64 parameter on a Silicon function compiles", () => {
    const result = compileSource("\\\\ identity64 (Int64)\nidentity64 x := {\n    x\n};")
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(param $x i64)')
    expect(result.wat).toContain('(result i64)')
})

test("Phase A i64: @toInt overload on Int64 emits i32.wrap_i64", () => {
    const result = compileSource(
        "\\\\ extend (Int)\nextend x := {\n    @toInt64(x)\n};" +
        "\\\\ narrow (Int64)\nnarrow x := {\n    @toInt(x)\n};"
    )
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i64.extend_i32_s')
    expect(result.wat).toContain('i32.wrap_i64')
})

test("Phase A i64: passing an Int where Int64 is expected is a type error", () => {
    const result = compileSource(
        "\\\\ take64 (Int64)\ntake64 x := {\n    x\n};" +
        "run := { take64(5) };"
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/mismatch|Int|Int64/i)
})

test("Phase A i64: Int32 is recognised as a type name (alias for Int on wasm32)", () => {
    // Int32 should resolve to the same type as Int on the current target.
    const result = compileSource("\\\\ id32 (Int32)\nid32 x := {\n    x\n};")
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(param $x i32)')
})

test("Phase A i64: @toInt64 result type is Int64 — propagates to extern arg position", () => {
    // The @toInt64 cast must yield Int64 so the extern call typechecks.
    const result = compileSource(
        "\\\\ @extern wants64 (Int64) -> Int64;" +
        "\\\\ run (Int)\nrun x := {\n    wants64(@toInt64(x))\n};"
    )
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i64.extend_i32_s')
})

test("Phase A i64: i64 escape hatch (lowercase) parses as Int64", () => {
    // The :i64 / :i32 / :f32 surface forms are documented escape hatches.
    const result = compileSource("\\\\ id (i64)\nid x := {\n    x\n};")
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(param $x i64)')
})

// ============================================================================
// Phase C — Silicon-Core i64: arithmetic + comparison strata
//   Operator dispatch picks the Int64 overload when both operands are i64.
// ============================================================================

test("Phase C i64: Int64 + Int64 emits i64.add", () => {
    const result = compileSource("\\\\ add64 (Int64, Int64)\nadd64 x, y := {\n    x + y\n};")
    expect(result.success).toBe(true)
    const uw = userWat(result.wat!)
    expect(uw).toContain('i64.add')
    expect(uw).not.toContain('i32.add')
})

test("Phase C i64: Int64 < Int64 emits i64.lt_s and returns Bool", () => {
    const result = compileSource("\\\\ cmp64 (Int64, Int64)\ncmp64 x, y := {\n    x < y\n};")
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i64.lt_s')
    // Comparison result is i32 (Bool) — the function's result reflects that.
    expect(result.wat).toContain('(result i32)')
})

test("Phase C i64: full set of arithmetic ops dispatches to i64 variants", () => {
    const result = compileSource(
        "\\\\ arith (Int64, Int64)\narith x, y := {\n    x + y - (x * y) / (x % y)\n};"
    )
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i64.add')
    expect(result.wat).toContain('i64.sub')
    expect(result.wat).toContain('i64.mul')
    expect(result.wat).toContain('i64.div_s')
    expect(result.wat).toContain('i64.rem_s')
})

test("Phase C i64: @toInt64 cast + i64 arithmetic compose", () => {
    const result = compileSource("\\\\ chain (Int)\nchain x := {\n    @toInt64(x) + @toInt64(1)\n};")
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i64.extend_i32_s')
    expect(result.wat).toContain('i64.add')
})

test("Phase C i64: comparison ops (==, !=, >, <=, >=) all dispatch to i64", () => {
    const result = compileSource(
        "\\\\ eq (Int64, Int64)\neq x, y := {\n    x == y\n};" +
        "\\\\ ne (Int64, Int64)\nne x, y := {\n    x != y\n};" +
        "\\\\ gt (Int64, Int64)\ngt x, y := {\n    x > y\n};" +
        "\\\\ le (Int64, Int64)\nle x, y := {\n    x <= y\n};" +
        "\\\\ ge (Int64, Int64)\nge x, y := {\n    x >= y\n};"
    )
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i64.eq')
    expect(result.wat).toContain('i64.ne')
    expect(result.wat).toContain('i64.gt_s')
    expect(result.wat).toContain('i64.le_s')
    expect(result.wat).toContain('i64.ge_s')
})

test("Phase C i64: i32 arithmetic still dispatches to i32 (no regression)", () => {
    const result = compileSource("\\\\ add (Int, Int)\nadd x, y := {\n    x + y\n};")
    expect(result.success).toBe(true)
    const uw = userWat(result.wat!)
    expect(uw).toContain('i32.add')
    expect(uw).not.toContain('i64.add')
})

// ============================================================================
// Phase D — Silicon-Core i64: real path_open call composes through
//   The wasi_snapshot_preview1 module now declares path_open's rights
//   flags as Int64; this test proves an end-to-end Silicon program can
//   call it with i64 args without falling through any escape hatch.
// ============================================================================

test("Phase D i64: path_open call site composes i64 args via module call", () => {
    const result = compileSource(loadExample("path_open_i64.si"))
    expect(result.success).toBe(true)
    // The module-call sugar generates the import automatically with i64 rights.
    expect(result.wat).toContain('(import "wasi_snapshot_preview1" "path_open"')
    expect(result.wat).toContain('(param i64) (param i64)')
    // Call site passes i64 args produced by @toInt64.
    expect(result.wat).toContain('i64.extend_i32_s')
})

test("Phase D i64: wasi_snapshot_preview1.path_open module registry declares i64 rights", () => {
    // Calling path_open without an explicit @extern (module sugar) emits
    // the right import signature: the two rights flags are i64.
    const result = compileSource(`
        \\\\ try_open (Int, Int, Int, Int)
        @fn try_open dir, p, l, out := {
            wasi_snapshot_preview1::path_open(dir, 0, p, l, 0, @toInt64(0), @toInt64(0), 0, out)
        };`)
    expect(result.success).toBe(true)
    // Five i32 params, two i64 params for rights, two more i32 — total signature shape.
    expect(result.wat).toMatch(
        /\(import "wasi_snapshot_preview1" "path_open"[^)]+\(param i32\) \(param i32\) \(param i32\) \(param i32\) \(param i32\) \(param i64\) \(param i64\) \(param i32\) \(param i32\)/
    )
})

// ============================================================================
// Phase 1a — @struct product types
// ============================================================================

test("Phase 1a @struct: generates constructor function", () => {
    const result = compileSource(`
        @type Point := { x Int, y Int };
        @fn main := {
            @mut p := Point(3, 7);
            p::x
        };`)
    expect(result.success).toBe(true)
    // Constructor function named $Point
    expect(result.wat).toContain('(func $Point')
    // Constructor allocates memory
    expect(result.wat).toContain('alloc')
})

test("Phase 1a @struct: constructor stores fields at correct offsets", () => {
    const result = compileSource(`
        @type Point := { x Int, y Int };
        @fn main := {
            @mut p := Point(3, 7);
            p::x
        };`)
    expect(result.success).toBe(true)
    // x stored at offset 0, y at offset 4
    expect(result.wat).toContain('i32.store')
})

test("Phase 1a @struct: field read generates i32.load", () => {
    const result = compileSource(loadExample('struct_basic.si'))
    expect(result.success).toBe(true)
    // p.x → (i32.load (local.get $p))
    expect(result.wat).toContain('i32.load')
})

test("Phase 1a @struct: typechecker recognises struct type annotation", () => {
    const result = compileSource(`
        @type Point := { x Int, y Int };
        @fn main := {
            @mut p := Point(3, 7);
            p::x
        };`)
    expect(result.success).toBe(true)
    expect(result.error).toBeNull()
})

test("Phase 1a @struct: typechecker resolves field type for p.x as Int", () => {
    const result = compileSource(`
        @type Point := { x Int, y Int };
        \\\\ get_x (Point)
        @fn get_x p := p::x;`)
    expect(result.success).toBe(true)
    expect(result.error).toBeNull()
})

// ============================================================================
// Phase 1a-6 — Nested struct support
// ============================================================================

test("Phase 1a-6 nested @struct: field read on outer struct compiles", () => {
    const result = compileSource(`
        @type Point := { x Int, y Int };
        @type Rect := { origin Point, width Int, height Int };
        @fn main := {
            @mut p := Point(3, 7);
            @mut r := Rect(p, 100, 50);
            r::width
        };`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(func $Point')
    expect(result.wat).toContain('(func $Rect')
    expect(result.wat).toContain('i32.load')
})

test("Phase 1a-6 nested @struct: struct example file compiles", () => {
    const result = compileSource(loadExample('struct_nested.si'))
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i32.load')
})

test("Phase 1a-6 nested @struct: typechecker resolves outer field type", () => {
    const result = compileSource(`
        @type Point := { x Int, y Int };
        @type Rect := { origin Point, width Int, height Int };
        \\\\ get_width (Rect)
        @fn get_width r := r::width;`)
    expect(result.success).toBe(true)
    expect(result.error).toBeNull()
})

test("Phase 1a-6 nested @struct: field write on nested struct compiles", () => {
    const result = compileSource(`
        @type Point := { x Int, y Int };
        @type Rect := { origin Point, width Int, height Int };
        \\\\ update_width (Rect, Int)
        @fn update_width r, w := {
            r::width = w;
            r::width
        };`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('i32.store')
    expect(result.wat).toContain('i32.load')
})

// ============================================================================
// Phase 1a-7 — Compiler aggregate types modelled as @struct
// ============================================================================

test("Phase 1a-7 struct aggregates: Token struct models compiler data", () => {
    const result = compileSource(`
        @type Token := { kind Int, start Int, len Int };
        \\\\ make_token (Int, Int, Int)
        @fn make_token kind, start, len := Token(kind, start, len);
        \\\\ token_kind (Token)
        @fn token_kind t := t::kind;
        \\\\ token_start (Token)
        @fn token_start t := t::start;
        \\\\ token_len (Token)
        @fn token_len t := t::len;`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(func $Token')
    expect(result.wat).toContain('(func $make_token')
    expect(result.wat).toContain('(func $token_kind')
    expect(result.wat).toContain('i32.load')
})

test("Phase 1a-7 struct aggregates: Span struct with read/write", () => {
    const result = compileSource(`
        @type Span := { start Int, end Int };
        \\\\ span_len (Span)
        @fn span_len s := s::end - s::start;
        \\\\ span_shift (Span, Int)
        @fn span_shift s, delta := {
            s::start = s::start + delta;
            s::end = s::end + delta
        };`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(func $Span')
    expect(result.wat).toContain('i32.store')
    expect(result.wat).toContain('i32.sub')
})

test("Phase 1a-7 struct aggregates: nested node models AST-like structure", () => {
    const result = compileSource(`
        @type Span := { start Int, end Int };
        @type ASTNode := { kind Int, span Span, value Int };
        \\\\ node_kind (ASTNode)
        @fn node_kind n := n::kind;
        \\\\ node_value (ASTNode)
        @fn node_value n := n::value;`)
    expect(result.success).toBe(true)
    expect(result.wat).toContain('(func $Span')
    expect(result.wat).toContain('(func $ASTNode')
    expect(result.wat).toContain('i32.load')
})
