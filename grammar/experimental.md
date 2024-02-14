# Grammar Experiments

Silicon aims to be simple but flexible and able to easily adding new features without fundamentally changing the language or grammar; much like how LISP works (for interpreted mode).

Let's go over a few examples.

## '??' null-coalescing operator

```csharp
var message = userName ?? "Anonymous User";
Console.WriteLine(message);
```

How would Silicon implement this without adding yet another operator? Silicon's core obstraction is the `function`. We can also use functions as infix with `\\` syntax.

```silicon
@name message = userName `\\default` "Anonymous User"
```

I used the function name `default` since that is usually what the goal of the null-coalescing operator. Or we could call it `ifNull` or `nullDefault` or `NullCoalesce`.

### Pros

- Can easily be added and used without changing the grammar
- Functions are more flexible
- Functions have names which are more explicit than operators

### Cons

- Operators _can_ be universal-ish across many programming languages
- Operators are natural-language agnostic. Translating function names is difficult.
- Operators are shorter to type (but LSPs can help)

## `...` / `..` Spread Operator

Javascript has had this for awhile, approaching a decade now since ES6 in 2015.

C# recently, finally, added this with `..`. Unfortunately, operators aren't _always_ universal as I mentioned they're universal-ish.

_Spread_ is a short and intuitive word to use. Again, Silicon _really_ avoids adding operators. In this case, this operator is **PERMANENTLY BLOCKED** because `...` is a [unary operator](https://en.wikipedia.org/wiki/Unary_operation). The `??` is at least possible since it take two arguments.

```javascript
let left = [1, 2, 3, 4];
let right = [6, 7, 8, 9];
let total = [...left, 5, ...right];
```

Let's translate this to Silicon

```silicon
@let left = [1, 2, 3, 4];
@let right = [6, 7, 8, 9];
@let all = [(#spread left), 5, (#spread right)];
```

We could also use the `#spread` function as a method thanks to [UFCS](https://en.wikipedia.org/wiki/Uniform_Function_Call_Syntax). This changes the last line to look like:

```silicon
@let all = [#left.spread, 5, #right.spread];
```

I personally like this **SO** much better.

### `...` as Gather?

`Silicon` by default is a statically typed compiled language that doesn't support variadic functions, ad-hoc polymorphism.

Silicon _does_ have a _Dynamic mode_ which _will_ support such a thing. This could be suppored at compile time or runtime. Rust does this at compile time with its macros. Silicon uses more a `Zig` approach with `##` sigil for comptime.

```javascript
function greetFriends(...friends) {
  friends.forEach((friend) => console.log(`hi, ${friend}`));
}
```

Let's do this both at compile time and runtime with Silicon.

### compile time gather `##gather`

I could do a function annotation like `@@gather friends` too.

I also could use a built-in function that does the gathering at compile time

I decided to keep both style as close as possible.

```silicon
@func greetFriends ##friends.gather:string = {
  #friends.each \friend => #print `hi, ${friend}`;
};
```

### `#gather` runtime gather

We could still add the `:string` as a type hint here but it isn't required in either example; thanks type-inference.

```
@func greetFriends #friends.gather:string = {
  #friends.each \friend => #print `hi, ${friend}`;
};
```

You'll notice the only difference is `#` for a _run-time function call_ and `##` for a _compile-time function call_. Again, Silicon tries to be consistent and intutive. _Intuitive_ being defined as the ability to easily extrapolate advanced rules from the initial atoms / axioms given.

## `*=` and `+=` and `??=`

How do we do this?

```csharp
(numbers ??= new List<int>()).Add(5);
```

If `numbers` is null then intialize it and add 5.

```silicon
numbers = numbers \\default #list:int.add 5
```

This isn't too bad but we don't get the shorter syntax that we're referencing `numbers` an itself.

```silicon
#self numbers, \\default #list:int.add 5
```

OR as infix which is closer to `??=`

`mut`, `update`, `set` are probably better names when used as a method. I have thought about making the Ruby `!` convention,
adding a `!` to the end of function names to indiciate they mutate their receiver, as a compile-time enforced rule. Another benefit of not have `!` as an operator to avoid confusion for humans and parsers alike.

```silicon
#numbers.set! \\default #list:int.add 5
```

`@set` could be defined like this.

Take a mutatable generic reference to a variable. Then apply the given action (function or lambda) to it.

```silicon
@func set! var:@mut:'T, action:@block = {
var = #var.action
}
```

## Literals, Literally.

_4 Februrary, 2024_

### Tuple and Array

Tuples and arrays both use `[]` delimited by `,` and can be distinguished by their type factory functions or the use of mixed types of values.
Arrays are a continuous block of memory of a single type i.e. array of 32bit integers.
Tuples are a continuous blok of memory of mixed types i.e. 32bit integer, string, bool.

```silicon
@let id, name, hasChildren = ## Tuple [1,"Nate", @true]
@let id, age, children    = ## Array [1, 32, 2]
```

I changed Tuples and Arrays to both use the same bracket type for consistency. This also means if they both use `[]` that `()` do not have _any_ special meaning
beyond grouping expressions. Why am I so anti-parenthesis? **shrug**.

### Map

Maps and Blocks both use `{}` delimited by `;`.

Maps aka Dictionaries are collections of key,value pairs.
Using `key=value,` is _okay_.

```silicon
@let map = ##map {id=1;name="Nathan";hasChildren=@true}
```

I really like Chat GPT's suggestion of using arrows `->`, delimited by `;`, like lambda functions do in some languages.
Maps can just be collections of parameterless named functions that map (evaluate) to a single value, more or less.

Using thin-arrow `->` also keeps `=` exclusive to expressions but does introduce another operator `->`.

```silicon
@let map = ##map {id->1;name->"Nathan";hasChildren->@true}
```

Grammar

```ohm
mapEntry = identifier "->" EXP
MapLiteral = "{" ListOf<mapEntry,";"> "}"
```

### Block

A blocks of code which is a list of expressions and statements. `Block` refers to both `function` and `lambda`.

```silicon
@let myBlock = {@let a = 3; @let b = 5; a**b+12;}
@let myBlock = {@let a = 3; @let b = 5; a**b+12;}
```

Lamda

```silicon
\
```
