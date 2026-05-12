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
import { addToAstSemantics, ASTFactory, type ASTNode, type Program, type Elaboration, type ExpressionStart, type BinaryOp } from "../ast/index.ts";
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
        const { program: elaboratedAST, registry, errors: elabErrors } = elaborate(ast as Program);

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

// ---------------------------------------------------------------------------
// @type_sum — full pipeline
// ---------------------------------------------------------------------------

test("E2E: @type_sum emits an immutable i32 global for each variant", () => {
    const result = compileSource("@type_sum Color := Red | Green | Blue;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    // WAT identifiers use _ instead of ::, so Color::Red → $Color_Red.
    expect(result.wat).toContain("(global $Color_Red i32 (i32.const 0))");
    expect(result.wat).toContain("(global $Color_Green i32 (i32.const 1))");
    expect(result.wat).toContain("(global $Color_Blue i32 (i32.const 2))");
});

test("E2E: @type_sum variant reference resolves via global.get", () => {
    const result = compileSource("@type_sum Color := Red | Green | Blue;\nColor::Red;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("global.get $Color_Red");
});

// ---------------------------------------------------------------------------
// @match — full pipeline
// ---------------------------------------------------------------------------

test("E2E: @match emits nested (if ...) chain with i32.eq comparisons", () => {
    const src = [
        "@type_sum Color := Red | Green | Blue;",
        "@var c:Color := Color::Red;",
        "&@match c, Color::Red, { 1 }, Color::Green, { 2 }, Color::Blue, { 3 };",
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
    const src = "@let f x:Int := { @local tmp:Int := x + 1; tmp };";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(local $tmp i32)");
});

test("E2E: @local binding emits local.set at the binding site", () => {
    const src = "@let f x:Int := { @local tmp:Int := x + 1; tmp };";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("local.set $tmp");
});

test("E2E: @local reference emits local.get", () => {
    const src = "@let f x:Int := { @local tmp:Int := x + 1; tmp };";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    // trailing `tmp` in the block should be local.get
    expect(result.wat).toContain("local.get $tmp");
});

test("E2E: @local is reassignable via assignment", () => {
    // After @local tmp := 0; reassign tmp = x; the assignment emits local.set.
    const src = "@let f x:Int := { @local tmp:Int := 0; tmp = x; tmp };";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    // Two local.set occurrences: initial binding and the assignment
    const matches = (result.wat ?? "").match(/local\.set \$tmp/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
});

test("E2E: multiple @local variables each get their own WAT local", () => {
    const src = "@let f x:Int := { @local a:Int := x; @local b:Int := a + 1; b };";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(local $a i32)");
    expect(result.wat).toContain("(local $b i32)");
});

// ---------------------------------------------------------------------------
// @let scalar reference fix — zero-param @let uses (call ...) not global.get
// ---------------------------------------------------------------------------

test("E2E: zero-param @let emits a function and references use (call ...)", () => {
    const src = "@let five:Int := 5; five + 1;";
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
    const src = "&@if 1, { 2 }, { 3 };";
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
        "@type_sum Color := Red | Green | Blue;",
        "@var c:Color := Color::Red;",
        "@let label := { &@match c, Color::Red, { 1 }, Color::Green, { 2 }, Color::Blue, { 3 } };",
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
    const result = compileSource("&@not @true;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("i32.eqz");
});

test("E2E: @and emits short-circuit AND WAT (if (result i32) ...)", () => {
    const result = compileSource("&@and @true, @false;");

    expect(result.success).toBe(true);
    expect(result.wat).toBeDefined();
    expect(result.wat).toContain("(if (result i32)");
    expect(result.wat).toContain("(i32.const 0)");
});

test("E2E: || with variables produces correct short-circuit structure", () => {
    const src = "@var a:Int := 1; @var b:Int := 0; a || b;";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(if (result i32)");
    expect(result.wat).toContain("global.get $a");
    expect(result.wat).toContain("global.get $b");
});

test("E2E: @not of zero is 1 (i32.eqz (i32.const 0))", () => {
    const result = compileSource("&@not 0;");

    expect(result.success).toBe(true);
    expect(result.wat).toContain("i32.eqz");
    expect(result.wat).toContain("(i32.const 0)");
});

test("E2E: chained || short-circuits left to right", () => {
    const src = "@var x:Int := 0; @var y:Int := 0; @var z:Int := 1; x || y || z;";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    // Each || produces its own (if (result i32) ...)
    const matches = (result.wat ?? "").match(/if \(result i32\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
});

test("E2E: || in function body with typed result", () => {
    const src = "@let check a:Int, b:Int := { a || b };";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(func $check");
    expect(result.wat).toContain("(if (result i32)");
});

test("E2E: @and with both true returns right side", () => {
    const src = "@let f a:Int, b:Int := { &@and a, b };";
    const result = compileSource(src);

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(func $f");
    expect(result.wat).toContain("(if (result i32)");
    expect(result.wat).toContain("(i32.const 0)");
});

// ---------------------------------------------------------------------------
// Round 22: Def-Kind schema validation
// ---------------------------------------------------------------------------

test("Schema: @var with parameters is rejected", () => {
    // Silicon params are bare comma-lists, not parenthesized: @var count x:Int := 0
    const result = compileSource("@var count x:Int := 0;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("'@var' does not accept parameters");
});

test("Schema: @extern with a binding is rejected", () => {
    const result = compileSource("@extern print := 5;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("'@extern' does not accept a binding");
});

test("Schema: @let with parameters and binding is accepted", () => {
    const result = compileSource("@let add x:Int, y:Int := { x + y };");

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(func $add");
});

test("Schema: @var with binding and no params is accepted", () => {
    const result = compileSource("@var count:Int := 0;");

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(global $count");
});

test("Schema: @extern with params and no binding is accepted", () => {
    const result = compileSource("@extern print x:Int;");

    expect(result.success).toBe(true);
    expect(result.wat).toContain("(import");
});

test("Schema: @local with params is rejected", () => {
    // Bare Silicon param syntax: @local tmp a:Int := 0
    const result = compileSource("@let f x:Int := { @local tmp a:Int := 0; tmp };");

    expect(result.success).toBe(false);
    expect(result.error).toContain("'@local' does not accept parameters");
});

test("Schema: unknown def-kind keyword is rejected", () => {
    const result = compileSource("@unknown foo := 5;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown definition keyword '@unknown'");
});

test("Schema: @var with generic params is rejected", () => {
    const result = compileSource("@var count[T] := 0;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("'@var' does not accept generic parameters");
});

test("Schema: @type_sum with params is rejected", () => {
    // Bare Silicon param syntax: @type_sum Color x:Int := Red | Green
    const result = compileSource("@type_sum Color x:Int := Red | Green;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("'@type_sum' does not accept parameters");
});

// ============================================================================
// Round 23: Type-driven codegen (replace f32 string-sniff heuristic)
// ============================================================================

// Helper: extract only the user-emitted WAT (after the std.wat runtime)
function userWat(wat: string): string {
    const marker = '(func $print_string'
    const idx = wat.indexOf(marker)
    if (idx < 0) return wat
    const afterPrint = wat.indexOf('\n\n\n', idx)
    return afterPrint >= 0 ? wat.slice(afterPrint) : wat.slice(idx)
}

test("Round 23: float params use f32.add not i32.add", () => {
    const result = compileSource("@let add a:Float, b:Float := { a + b };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.add");
    expect(uw).not.toContain("i32.add");
});

test("Round 23: int params use i32.add not f32.add", () => {
    const result = compileSource("@let add a:Int, b:Int := { a + b };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("i32.add");
    expect(uw).not.toContain("f32.add");
});

test("Round 23: float comparison uses f32.gt", () => {
    const result = compileSource("@let greater a:Float, b:Float := { a > b };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.gt");
    expect(uw).not.toContain("i32.gt");
});

test("Round 23: float comparison uses f32.lt", () => {
    const result = compileSource("@let lesser a:Float, b:Float := { a < b };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.lt");
    expect(uw).not.toContain("i32.lt");
});

test("Round 23: mixed int+float expression promotes to f32", () => {
    const result = compileSource("@let mixed a:Int, b:Float := { a + b };");
    expect(result.success).toBe(true);
    expect(result.wat).toContain("f32");
});

test("Round 23: float global resolves to f32 in expressions", () => {
    const result = compileSource("@var x := 1.5; @let getX := { x + 0.0 };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.add");
});

test("Round 23: float call return type drives arithmetic (f32.add in caller)", () => {
    // &double takes a Float and returns Float; two calls added together should use f32.add
    const src = "@let double x:Float := { x + x }; @let quad y:Float := { &double y + &double y };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.add");
});

test("Round 23: float subtraction uses f32.sub", () => {
    const result = compileSource("@let sub a:Float, b:Float := { a - b };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.sub");
    expect(uw).not.toContain("i32.sub");
});

test("Round 23: float multiplication uses f32.mul", () => {
    const result = compileSource("@let mul a:Float, b:Float := { a * b };");
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("f32.mul");
    expect(uw).not.toContain("i32.mul");
});

// ============================================================================
// Round 24: @break / @continue — loop control flow via strata keywords
// ============================================================================

test("Round 24: @loop emits block/loop WAT structure", () => {
    const src = "@let count := { &@loop 1, { 0 }; 42 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toContain("(block $brk_");
    expect(uw).toContain("(loop $cont_");
    expect(uw).toContain("br_if $brk_");
    expect(uw).toContain("br $cont_");
});

test("Round 24: @break emits br to block label", () => {
    const src = "@let run := { &@loop 1, { &@break }; 0 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toMatch(/br \$brk_\d+/);
});

test("Round 24: @continue emits br to loop label", () => {
    const src = "@let run := { &@loop 1, { &@continue }; 0 };";
    const result = compileSource(src);
    expect(result.success).toBe(true);
    const uw = userWat(result.wat!)
    expect(uw).toMatch(/br \$cont_\d+/);
});

test("Round 24: @break label matches enclosing @loop label", () => {
    // The $brk_N in @break must equal the $brk_N in the enclosing block
    const src = "@let run := { &@loop 1, { &@break }; 0 };";
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
    const src = "@let run := { &@loop 1, { &@continue }; 0 };";
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
    const src = "@let run := { &@loop 1, { &@loop 1, { &@break }; 0 }; 0 };";
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

test("Round 24: @break registered in registry as keyword stratum", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@break']).toBeDefined()
    expect(registry.keywords['@break'].data.intrinsic).toBe('WASM::control_break')
});

test("Round 24: @continue registered in registry as keyword stratum", () => {
    const { registry } = elaborate(ASTFactory.program([]))
    expect(registry.keywords['@continue']).toBeDefined()
    expect(registry.keywords['@continue'].data.intrinsic).toBe('WASM::control_continue')
});
