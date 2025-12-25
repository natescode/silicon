# Types

One of Silicon's biggest goals is to develop a simple but powerful type system that map well to WASM and Javascript.

## Numeric

Idiomatic Silicon uses sum types.

Typically used as `number`

```typescript
type integer = i32 | i64;
type float = f32 | f64;
type number = integer | float;
type decimal = int; // maps to BigInt
```

- `i32`
- `i64`
- `f32`
- `f64`

Silicon has 8 primitive data types

- ref
- vec
- atom
- bool
- int (LEB128)
- float (IEEE 754)
- decimal (128 bit)
- string
  ~~- rune~~

## Ref

`ref = func_ref | extern_ref`

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

Char is poorly defined. Unicode codepoint is clearly defined but doesn't always match the human definition, I.E one emoji can be 3+ codepoints.

Silicon only has strings. If one _really_ needs a _"character"_ type, type guards can be used.

        // define a string with width 1
        @let char: str(width=1)

Strings do not have `length`. Instead there are `width`,`bytes`,and `codepoints`

## String

`str`

Silicon uses UTF-8 encoded strings. UTF-16 and UTF-32 are available as well.

    @let name = "Nathan" # UTF-8
    @let name = #UTF16 "Nathan" # UTF-16

### No Length?

Strings don't have `length` because that is poorly defined. Strings have 3 properties: bytes, runes (codepoints), and graphemes (grapheme clusters).

`bytes` is the number of bytes required to represent the string.
`runes` alias for codepoints, is the number of unicode codepoints used to represent the string.
`grapheme` is how many visual symbols wide the string is. Known as grapheme clusters. Still ambigous since some systems may or may not combine multiple codepoints into one symbol.

Example string

    "ü❤️Silicon"

    bytes = 13
    runes = 10
    graphemes = 9

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

`$VOID`

Silicon doesn't have these types. Optionals are used instead.

## Alias Types

Silicon has type aliases as well. They're just aliases or other local names for a type.

```silicon
@type_alias age = int;

@let my_age: int = 34;
@let cat_age: age = 4;

my_age > cat_age; // true
```

## Distinct Types

Similar to Odin, Silicon has distinct types. These are *like* aliases but make a completely new type from an existing one.

```silicon
@type_distinct age = int;

@let my_age: int = 34;
@let cat_age: age = 4;

my_age > cat_age; // false, cast needed!
my_age.cast()
```

## Opaque Types

Silicon also has opaque types where the underlying representation may not be observed by the consumer. WASM has this as well.

```silicon
@type_opaque UserId = int;

# consumer has no idea UserId is int or GUID or what.
@@open foo_lib @@import UserId;

@@type_of UserId; // @opaque (cannot see underlying representation)

```

## References

Silicon needs references. Since Silicon mainly targets WASM, it too has function and external references.

References are opaque is a type that hide its underlying encoding. WASM has this for security purposes and referencing types from C or other languages via FFI.
