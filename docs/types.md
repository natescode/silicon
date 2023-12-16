# Types

One of Silicon's biggest goals is to develop a simple but powerful type system that map well to WASM and Javascript.

## Numeric

Idiomatic Silicon uses sum types.

Typically used as `number`

```typescript
type integer = i32 | i64;
type float = f32 | f64;
type number = integer | float;
```

- `i32`
- `i64`
- `f32`
- `f64`

Silicon has 8 primitive data types

- opaque
- vec
- atom
- bool
- int (LEB128)
- float
- decimal
- string
  ~~- rune~~

## Opaque

## Vec

`vec` - v128 for WASM. For SIMD instructions.

## Atom

Atoms only have one value, themselves. `$true` and `$false` are atoms.

Declare an ATOM by using the `$` sigil. Since atom have one value, they're immutable!

## Numeric Types

### Integer

`int`

Integers are whole numbers are LEB128 variable byte integers that can be signed, unsigned or uninterpreted. I may allow arbitrary sized like Zig `u7`. They start as 32 bits.

Maps best to Javascript's `bigint`.

## Float

`float`

Floating point numbers are signed 32 or 64 bit (based on WASM mode)IEEE 754 floating point values can be positive or negative, and can include a fractional component.

## Decimal

`decimal`

Silicon has a decimal type for high precision financial calculations. Decimal is actually encoded with WASM's 128 bit vector type used for SIMD instructions.

## Character

`str(width=1)` ?

`rune` is a UTF-32 codepoint ?

char is poorly defined. Unicode codepoint is clearly defined but doesn't always match the human definition, I.E one emoji can be 3+ codepoints.

Silicon only has strings. If one _really_ needs a _"character"_ type, type guards can be used.

        // define a string with width 1
        @let char: str(width=1)

Strings do not have `length`. Instead there are `width`,`bytes`,and `codepoints`

## String

`str`

Silicon uses UTF-32 encoded strings. UTF-16 and UTF-8 are available as well.

    @let name = "Nathan" // UTF-32
    @let name = #UTF16 "Nathan"

### No Length?

Strings don't have `length` because that is poorly defined. Strings have 3 properties: width, bytes, and runes (codepoints).

`width` is how many visual symbols wide the string is.
`bytes` is the number of bytes required to represent the string.
`runes` alias for codepoints, is the number of unicode codepoints used to represent the string.

Example string

    "ü❤️Silicon"

    width = 9
    bytes = 13
    runes = 10

`ü` it one character wide. 2 bytes. 2 codepoints.

`️❤️` is one charater wide. 4 bytes. 2 codepoints.

Emojis can get crazy with modifiers. `👩🏿‍🚀` This is a combination of (Woman) + (dark skin tone) + ZWJ + rocket.

So `👩🏿‍🚀` is actually 4 codepoints, 16 bytes and 1 'character' (wide).

## Booleans

`bool`

`@type bool = $true | $false`

Booleans can only be one of two different values: `true` or `false`. This type
is required by expressions such as `if`, `while`, and `assert`.

## Null & Undefined

Silicon doesn't have these types. Optionals are used instead.

## Opaque

`opaque`

Opaque is a type that hide its underlying encoding. WASM has this for security purposes and referencing types from C or other languages via FFI.
