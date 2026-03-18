# WASM Intrinsics for Silicon

WASM intrinsics are built-in functions that provide direct access to WebAssembly capabilities from within Silicon code. They cannot be defined within Silicon itself but are available through the `WASM` namespace.

## Overview

Intrinsics are called using the Silicon function call syntax with the `WASM::` namespace:

```silicon
&WASM::i32_add arg1, arg2;
```

## Function Categories

### Integer Arithmetic (i32)

- `WASM::i32_add` - Add two i32 values
- `WASM::i32_sub` - Subtract two i32 values
- `WASM::i32_mul` - Multiply two i32 values
- `WASM::i32_div_s` - Divide two signed i32 values
- `WASM::i32_div_u` - Divide two unsigned i32 values
- `WASM::i32_rem_s` - Remainder of dividing two signed i32 values
- `WASM::i32_rem_u` - Remainder of dividing two unsigned i32 values

### Float Arithmetic (f32)

- `WASM::f32_add` - Add two f32 values
- `WASM::f32_sub` - Subtract two f32 values
- `WASM::f32_mul` - Multiply two f32 values
- `WASM::f32_div` - Divide two f32 values
- `WASM::f32_abs` - Absolute value of an f32
- `WASM::f32_neg` - Negate an f32 value
- `WASM::f32_sqrt` - Square root of an f32

### Integer Comparisons (i32)

All return 1 for true, 0 for false:

- `WASM::i32_eq` - Test if two i32 values are equal
- `WASM::i32_ne` - Test if two i32 values are not equal
- `WASM::i32_lt_s` - Signed less than
- `WASM::i32_lt_u` - Unsigned less than
- `WASM::i32_le_s` - Signed less than or equal
- `WASM::i32_le_u` - Unsigned less than or equal
- `WASM::i32_gt_s` - Signed greater than
- `WASM::i32_gt_u` - Unsigned greater than
- `WASM::i32_ge_s` - Signed greater than or equal
- `WASM::i32_ge_u` - Unsigned greater than or equal

### Float Comparisons (f32)

All return 1 for true, 0 for false:

- `WASM::f32_eq` - Test if two f32 values are equal
- `WASM::f32_ne` - Test if two f32 values are not equal
- `WASM::f32_lt` - Less than
- `WASM::f32_le` - Less than or equal
- `WASM::f32_gt` - Greater than
- `WASM::f32_ge` - Greater than or equal

### Bitwise Operations (i32)

- `WASM::i32_and` - Bitwise AND
- `WASM::i32_or` - Bitwise OR
- `WASM::i32_xor` - Bitwise XOR
- `WASM::i32_shl` - Shift left
- `WASM::i32_shr_s` - Arithmetic shift right (sign-extending)
- `WASM::i32_shr_u` - Logical shift right (zero-extending)
- `WASM::i32_rotl` - Rotate left
- `WASM::i32_rotr` - Rotate right

### Unary Integer Operations (i32)

- `WASM::i32_clz` - Count leading zeros
- `WASM::i32_ctz` - Count trailing zeros
- `WASM::i32_popcnt` - Count set bits (population count)

### Type Conversions

- `WASM::i32_trunc_f32_s` - Convert f32 to signed i32 (truncate)
- `WASM::i32_trunc_f32_u` - Convert f32 to unsigned i32 (truncate)
- `WASM::f32_convert_i32_s` - Convert signed i32 to f32
- `WASM::f32_convert_i32_u` - Convert unsigned i32 to f32

### Memory Operations

- `WASM::i32_load` - Load i32 from linear memory at address
- `WASM::i32_store` - Store i32 to linear memory at address
- `WASM::f32_load` - Load f32 from linear memory at address
- `WASM::f32_store` - Store f32 to linear memory at address
- `WASM::i32_load8_s` - Load signed byte and extend to i32
- `WASM::i32_load8_u` - Load unsigned byte and extend to i32
- `WASM::i32_store8` - Store least significant byte of i32

### Memory Management

- `WASM::data_memory` - Get current size of linear memory in pages
- `WASM::mem_grow` - Grow linear memory by specified number of pages

## Usage Examples

### Basic Arithmetic

```silicon
## Add two numbers
result = &WASM::i32_add 5, 3;

## Multiply floats
product = &WASM::f32_mul 2.5, 4.0;
```

### Comparisons

```silicon
## Check if a < b
is_less = &WASM::i32_lt_s a, b;

## Check if floats are equal
are_equal = &WASM::f32_eq x, y;
```

### Type Conversion

```silicon
## Convert float to integer (truncate towards zero)
int_value = &WASM::i32_trunc_f32_s float_value;

## Convert integer to float
float_value = &WASM::f32_convert_i32_s int_value;
```

### Memory Access

```silicon
## Load a 32-bit integer from address 0x100
value = &WASM::i32_load 256;

## Store value at address 0x200
&WASM::i32_store 512, value;
```

## Implementation Notes

### Direct Compilation

WASM intrinsics are compiled directly to their underlying WebAssembly instructions without the overhead of a function call. For example:

```silicon
&WASM::i32_add a, b;
```

Compiles to:

```wasm
(i32.add)
```

(with the arguments pushed on the stack first)

### Type Inference

Silicon uses type inference from literal values to select between i32 and f32 operations when using binary operators directly. However, when explicitly calling WASM intrinsics, you must use the correct variant (i32 vs f32) for your operand types.

### Stack-Based Evaluation

WebAssembly is a stack-based virtual machine. All intrinsics operate on the value stack:

- Arguments are evaluated and pushed onto the stack
- The intrinsic pops its inputs and pushes its outputs
- The calling convention handles matching stack depths

## Complete Intrinsic Reference

To see all available intrinsics programmatically:

```typescript
import { listWasmIntrinsics, getWasmIntrinsic } from '@sigil/intrinsics'

// List all intrinsic names
const allIntrinsics = listWasmIntrinsics()

// Get detailed information about an intrinsic
const addition = getWasmIntrinsic('WASM::i32_add')
console.log(addition.inputs)   // 2
console.log(addition.outputs)  // 1
console.log(addition.description)
```
