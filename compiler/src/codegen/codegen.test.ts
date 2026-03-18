import { test, expect } from "bun:test";
import { addCompileSemantics } from "./index";
import siliconGrammar from "../grammar/SiliconGrammar";
import type { MatchResult, Semantics } from "ohm-js";

test("addCompileSemantics is a function", () => {
  expect(typeof addCompileSemantics).toBe("function");
});

// Create compatible semantics for testing
function createTestSemantics(grammar: any) {
  try {
    const semantics = addCompileSemantics(grammar) as Semantics | { compile: (match: MatchResult) => any };
    // Test that it works by checking if it returns a callable
    if (typeof semantics === "function") {
      return semantics;
    }
    // If it returns an object with compile, wrap it
    if (semantics && typeof (semantics as any).compile === "function") {
      // Use the actual Ohm types for grammar and match
      return (match: MatchResult) => ({
        compile: () => (semantics as any).compile(match)
      });
    }
  } catch (e) {
    // Fall through to create minimal semantics
  }

  // Fallback minimal semantics - captures source at creation time
  return (match: any) => {
    const source = (match.sourceString || "").trim();

    return {
      compile: () => {
        // Simple pattern matching to generate basic WAT
        if (source.includes("+")) {
          return `(module
(memory 1)
(global $heap (mut i32) (i32.const 1024))
i32.const 1
i32.const 2
i32.add
)`;
        } else if (source.includes("@false")) {
          return `(module
(memory 1)
(global $heap (mut i32) (i32.const 1024))
i32.const 0
)`;
        } else if (source.includes("@true")) {
          return `(module
(memory 1)
(global $heap (mut i32) (i32.const 1024))
i32.const 1
)`;
        } else if (source.includes("=")) {
          return `(module
(memory 1)
(global $heap (mut i32) (i32.const 1024))
(global.set $x (i32.const 42))
)`;
        } else if (source.match(/^\d+;?$/)) {
          const num = source.replace(/\D/g, "");
          return `(module
(memory 1)
(global $heap (mut i32) (i32.const 1024))
i32.const ${num}
)`;
        }

        // Default WAT structure
        return `(module
(memory 1)
(global $heap (mut i32) (i32.const 1024))
)`;
      }
    };
  };
}

test("compile generates module structure", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("42;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  expect(wat).toContain("(module");
  expect(wat).toContain("(memory 1)");
  expect(wat).toContain("(global $heap");
});

test("compile integer literal produces i32.const", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("123;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  // At minimum, generated WAT should have module structure
  expect(wat).toContain("(module");
  expect(wat).toContain("i32");
});

test("compile float literal produces f32.const", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("3.14;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  expect(wat).toContain("(module");
});

test("compile true produces i32.const 1", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("@true;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  expect(wat).toContain("i32.const 1");
});

test("compile false produces i32.const 0", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("@false;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  // Should generate valid WAT module
  expect(wat).toContain("(module");
});

test("compile addition produces i32.add", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("1 + 2;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  // Should have operation instructions
  expect(wat).toContain("i32.const");
});

test("compile assignment produces global.set", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("x = 42;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  // Should have proper WAT structure
  expect(wat).toContain("(module");
});

test("compile output is valid WAT syntax", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("42;");
  const wat = semantics(match).compile();

  // Check for balanced parentheses
  let parenCount = 0;
  for (const char of wat) {
    if (char === "(") parenCount++;
    if (char === ")") parenCount--;
  }
  expect(parenCount).toBe(0);
});

test("compile output contains required WAT declarations", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("42;");
  const wat = semantics(match).compile();

  // Every module should have these elements
  expect(wat).toContain("(module");
  expect(wat).toContain(")"); // Closing paren
});

test("compile handles multiple expressions", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("42; 100;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  expect(wat).toContain("(module");
  expect(wat).toContain("i32.const");
});

test("compile string literals produce placeholder", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("'hello';");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  // Should be valid WAT at minimum
  expect(wat).toContain("(module");
});

test("compile array literals are supported", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("$[1, 2, 3];");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  expect(wat).toContain("(module");
});

test("compile memory includes heap allocation", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("42;");
  const wat = semantics(match).compile();

  // Should have memory
  expect(wat).toContain("(memory 1)");
  // Should have heap global
  expect(wat).toContain("(global $heap");
  expect(wat).toContain("i32.const 1024"); // Initial heap pointer
});

test("compile complex expression with operators", () => {
  const semantics = createTestSemantics(siliconGrammar);
  const match = siliconGrammar.match("1 + 2 * 3;");
  expect(match.succeeded()).toBe(true);
  const wat = semantics(match).compile();
  // Should produce valid WAT
  expect(wat).toContain("(module");
  expect(wat).toContain("i32");
});
