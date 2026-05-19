import { test, expect } from "bun:test";
import { ASTFactory } from "./index";

// Unit tests: ASTFactory node creation
test("ASTFactory creates int literal node", () => {
  const node = ASTFactory.intLiteral("42", "decimal");
  expect(node.type).toBe("IntLiteral");
  expect(node.value).toBe("42");
  expect(node.base).toBe("decimal");
});

test("ASTFactory creates string literal node", () => {
  const node = ASTFactory.stringLiteral("hello");
  expect(node.type).toBe("StringLiteral");
  expect(node.value).toBe("hello");
});

test("ASTFactory creates program node", () => {
  const elements: any[] = [];
  const node = ASTFactory.program(elements);
  expect(node.type).toBe("Program");
  expect(node.elements).toBe(elements);
});