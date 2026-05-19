import { test, expect } from "bun:test";
import { parse } from "../parser/index";
import { addToAstSemantics } from "./index";
import siliconGrammar from "../grammar/SiliconGrammar";

// Create semantics for converting parse trees to AST
const semantics = addToAstSemantics(siliconGrammar);

// Integration tests: parse Silicon grammar then convert CST to AST
test("parse and toAst converts int literal to IntLiteral node", () => {
    const cst = parse("42;");
    const ast = semantics(cst).toAst();
    expect(ast.type).toBe("Program");
    expect(ast.elements.length).toBe(1);
    expect(ast.elements[0].type).toBe("IntLiteral");
    expect(ast.elements[0].value).toBe("42");
});

test("parse and toAst converts string literal to StringLiteral node", () => {
    const cst = parse("'hello';");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("StringLiteral");
    expect(ast.elements[0].value).toBe("hello");
});

test("parse and toAst converts float literal to FloatLiteral node", () => {
    const cst = parse("3.14;");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("FloatLiteral");
    expect(ast.elements[0].value).toBe("3.14");
});

test("parse and toAst converts boolean true to BooleanLiteral node", () => {
    const cst = parse("@true;");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("BooleanLiteral");
    expect(ast.elements[0].value).toBe(true);
});

test("parse and toAst converts boolean false to BooleanLiteral node", () => {
    const cst = parse("@false;");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("BooleanLiteral");
    expect(ast.elements[0].value).toBe(false);
});

test("parse and toAst converts array literal to ArrayLiteral node", () => {
    const cst = parse("$[1, 2, 3];");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("ArrayLiteral");
    expect(ast.elements[0].elements.length).toBe(3);
});

test("parse and toAst converts empty array to ArrayLiteral node", () => {
    const cst = parse("$[];");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("ArrayLiteral");
    expect(ast.elements[0].elements.length).toBe(0);
});

test("parse and toAst converts object literal to ObjectLiteral node", () => {
    const cst = parse("${a=1, b=2};");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("ObjectLiteral");
    expect(ast.elements[0].properties.length).toBe(2);
});

test("parse and toAst converts empty object to ObjectLiteral node", () => {
    const cst = parse("${};");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("ObjectLiteral");
    expect(ast.elements[0].properties.length).toBe(0);
});

test("parse and toAst converts tuple literal to TupleLiteral node", () => {
    const cst = parse("$(1, 2, 3);");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("TupleLiteral");
    expect(ast.elements[0].elements.length).toBe(3);
});

test("parse and toAst converts binary addition to BinaryOp node", () => {
    const cst = parse("1 + 2;");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("BinaryOp");
    expect(ast.elements[0].operator).toBe("+");
});

test("parse and toAst converts binary multiplication to BinaryOp node", () => {
    const cst = parse("3 * 4;");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("BinaryOp");
    expect(ast.elements[0].operator).toBe("*");
});

test("parse and toAst converts assignment to Assignment node", () => {
    const cst = parse("x = 42;");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("Assignment");
});

test("parse and toAst converts function call to FunctionCall node", () => {
    const cst = parse("&add 1, 2;");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("FunctionCall");
});

test("parse and toAst converts block to Block node", () => {
    const cst = parse("{ 1; 2; };");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("Block");
});

test("parse and toAst converts namespace to Namespace node", () => {
    const cst = parse("a::b::c;");
    const ast = semantics(cst).toAst();
    expect(ast.elements[0].type).toBe("Namespace");
});
