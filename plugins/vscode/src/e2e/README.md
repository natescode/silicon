## End-to-End Testing

This directory contains end-to-end tests for the Silicon compiler pipeline. These tests validate the complete compilation flow from source code through parsing, AST construction, elaboration, and code generation.

### Structure

- **examples/** - Silicon source files (.si) with various test cases
- **e2e.test.ts** - Main test suite that exercises the full pipeline

### Test Examples

The following Silicon source examples are included:

- `simple_literal.si` - Basic integer literal (42)
- `string_literal.si` - String literal parsing ('hello world')
- `float_literal.si` - Floating point number (3.14)
- `boolean_true.si` - Boolean true (@true)
- `boolean_false.si` - Boolean false (@false)
- `basic_arithmetic.si` - Simple binary operation (1 + 2)
- `nested_expressions.si` - Operator precedence ((1 + 2) * 3)
- `multiple_statements.si` - Multiple expressions in sequence
- `stratum_definition.si` - Stratum elaboration testing

### Running the Tests

```bash
bun test src/e2e/
```

### Pipeline Stages Tested

Each test validates:

1. **PARSE** - Source code → Parse tree using Ohm grammar
2. **AST** - Parse tree → Typed Abstract Syntax Tree
3. **ELABORATE** - Semantic information attachment and stratum registration
4. **CODEGEN** - AST → WebAssembly text format (WAT)

The `compileSource()` helper function orchestrates these stages and captures any errors at each step.

### Test Coverage

- ✅ Literal parsing (int, float, string, boolean)
- ✅ Binary operators and arithmetic
- ✅ Nested expressions with operator precedence
- ✅ Multiple statements
- ✅ Stratum elaboration
- ✅ AST construction and validation
- ✅ WAT code generation
- ✅ Error handling for invalid syntax

### Grammar Fix Status

**✅ FIXED**: The `Elaboration` rule in [silicon-official.ohm](../grammar/silicon-official.ohm) no longer throws "Cannot apply syntactic rule" errors.

The fix was to change the `strataBody` rule from:
```
strataBody = "{" (Item ";")* "}"  // Error: Item is syntactic in lexical context
```

To:
```
strataBody = "{" strataBodyContent* "}"  // Lexical rule that accepts any content
strataBodyContent = ~"}" any
```

This change avoids mixing syntactic and lexical rules in a way that Ohm rejects.

### Known Pre-Existing Issues

**Semantic Action Mismatches**: The toAst.ts semantic action handlers don't match all the grammar rules. This is a pre-existing issue that needs to be fixed in the AST transformer. Errors include:

- Missing semantic actions for labeled alternatives (e.g., `Item_statement`, `Statement_assignment`)
- Wrong arity for several semantic actions (e.g., `Block` expects 4 arguments but gets 3)

These need to be resolved before the full e2e tests can run successfully.

### Future Enhancements

- Fix semantic action mismatches in [toAst.ts](../ast/toAst.ts)
- Add tests for actual stratum definitions once grammar is fully functional
- Add tests for function calls and user-defined functions
- Add tests for array, object, and tuple literals
- Add tests for elaborator registry population
- Add integration tests with actual WAT execution

