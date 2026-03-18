/**
 * Builtin Elaborators
 *
 * These are the fundamental operators that Silicon provides out of the box.
 * Each is defined as a @stratum block that maps to WASM intrinsics.
 *
 * The builtin elaborators are parsed from Silicon source and registered
 * in the elaborator registry before user elaborators are processed.
 *
 * Bootstrap operators:
 * - Arithmetic: + - * / %
 * - Comparison: == != < > <= >=
 *
 * Each operator is defined as mapping its operands through a WASM intrinsic.
 * Type inference happens during codegen (i32 vs f32).
 */

/**
 * Silicon source code for builtin operator elaborators
 *
 * These @stratum blocks define how each operator is elaborated.
 * The Node parameter is substituted with actual operands during codegen.
 *
 * Example:
 *   @stratum Plus (Operator, "+", Node) = {
 *     &WASM::i32_add Node.left, Node.right;
 *   };
 *
 * When the compiler sees: 1 + 2
 * It elaborates to: &WASM::i32_add 1, 2
 */
export const BUILTIN_ELABORATORS_SOURCE = `
@stratum Plus (Operator, '+', Node) = {
  &WASM::i32_add Node.left, Node.right;
};

@stratum Minus (Operator, '-', Node) = {
  &WASM::i32_sub Node.left, Node.right;
};

@stratum Multiply (Operator, '*', Node) = {
  &WASM::i32_mul Node.left, Node.right;
};

@stratum Divide (Operator, '/', Node) = {
  &WASM::i32_div_s Node.left, Node.right;
};

@stratum Modulo (Operator, '%', Node) = {
  &WASM::i32_rem_s Node.left, Node.right;
};

@stratum Equal (Operator, '==', Node) = {
  &WASM::i32_eq Node.left, Node.right;
};

@stratum NotEqual (Operator, '!=', Node) = {
  &WASM::i32_ne Node.left, Node.right;
};

@stratum LessThan (Operator, '<', Node) = {
  &WASM::i32_lt_s Node.left, Node.right;
};

@stratum GreaterThan (Operator, '>', Node) = {
  &WASM::i32_gt_s Node.left, Node.right;
};

@stratum LessThanOrEqual (Operator, '<=', Node) = {
  &WASM::i32_le_s Node.left, Node.right;
};

@stratum GreaterThanOrEqual (Operator, '>=', Node) = {
  &WASM::i32_ge_s Node.left, Node.right;
};
`;

/**
 * List of builtin operator symbols
 * These are guaranteed to be available in any Silicon program
 */
export const BUILTIN_OPERATORS = [
  '+', '-', '*', '/', '%',      // Arithmetic
  '==', '!=', '<', '>', '<=', '>='  // Comparison
];
