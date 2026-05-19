import { test, expect } from "bun:test";
import { parse } from "./index";

test("parse is a function", () => {
  expect(typeof parse).toBe("function");
});

// Test parsing simple code
test("parse simple expression", () => {
  const result = parse("42;");
  expect(result).toBeDefined();
  expect(result.succeeded()).toBe(true);
});

// Test parsing integer literals
test("parse integer literal", () => {
  const result = parse("123;");
  expect(result.succeeded()).toBe(true);
});

// Test parsing float literals
test("parse float literal", () => {
  const result = parse("3.14;");
  expect(result.succeeded()).toBe(true);
});

// Test parsing string literals
test("parse string literal", () => {
  const result = parse("'hello world';");
  expect(result.succeeded()).toBe(true);
});

test("parse empty string", () => {
  const result = parse("'';");
  expect(result.succeeded()).toBe(true);
});

// Test parsing boolean literals
test("parse boolean true", () => {
  const result = parse("@true;");
  expect(result.succeeded()).toBe(true);
});

test("parse boolean false", () => {
  const result = parse("@false;");
  expect(result.succeeded()).toBe(true);
});

// Test parsing array literals
test("parse array literal", () => {
  const result = parse("$[1, 2, 3];");
  expect(result.succeeded()).toBe(true);
});

test("parse empty array", () => {
  const result = parse("$[];");
  expect(result.succeeded()).toBe(true);
});

// Test parsing object literals
test("parse object literal", () => {
  const result = parse("${a=1, b=2};");
  expect(result.succeeded()).toBe(true);
});

test("parse empty object", () => {
  const result = parse("${};");
  expect(result.succeeded()).toBe(true);
});

// Test parsing tuple literals
test("parse tuple literal", () => {
  const result = parse("$(1, 2, 3);");
  expect(result.succeeded()).toBe(true);
});

// Test parsing binary operations
test("parse binary addition", () => {
  const result = parse("1 + 2;");
  expect(result.succeeded()).toBe(true);
});

test("parse binary multiplication", () => {
  const result = parse("3 * 4;");
  expect(result.succeeded()).toBe(true);
});

test("parse complex expression", () => {
  const result = parse("1 + 2 * 3 - 4;");
  expect(result.succeeded()).toBe(true);
});

// Test parsing assignments
test("parse assignment", () => {
  const result = parse("x = 42;");
  expect(result.succeeded()).toBe(true);
});

test("parse assignment with expression", () => {
  const result = parse("y = 1 + 2;");
  expect(result.succeeded()).toBe(true);
});

// Test parsing function calls
test("parse function call", () => {
  const result = parse("&add 1, 2;");
  expect(result.succeeded()).toBe(true);
});

test("parse function call no args", () => {
  const result = parse("&print;");
  expect(result.succeeded()).toBe(true);
});

// Test parsing blocks
test("parse block", () => {
  const result = parse("{ x = 1; y = 2; };");
  expect(result.succeeded()).toBe(true);
});

test("parse empty block", () => {
  const result = parse("{};");
  expect(result.succeeded()).toBe(true);
});

// Test parsing namespaces
test("parse namespace", () => {
  const result = parse("a::b;");
  expect(result.succeeded()).toBe(true);
});

test("parse nested namespace", () => {
  const result = parse("a::b::c;");
  expect(result.succeeded()).toBe(true);
});

// Test parsing doc comments
test("parse doc comment", () => {
  const result = parse("## This is a comment");
  expect(result.succeeded()).toBe(true);
});

// Test parsing definitions
test("parse function definition", () => {
  const result = parse("@fn add x := 42;");
  expect(result.succeeded()).toBe(true);
});

// Test parsing parenthesized expressions
test("parse parenthesized expression", () => {
  const result = parse("(1 + 2) * 3;");
  expect(result.succeeded()).toBe(true);
});