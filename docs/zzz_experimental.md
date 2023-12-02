# EXPERIMENTAL ideas

According to [this blog post](https://soc.me/languages/type-annotations) inputs should be defined before outputs. I half agree BUT in this case the function name is still defined **BEFORE** and then the _type_ **AFTER** which feel really inconsistent.

    ```
        // the type of 'add' is added AFTER the parameters?
        fn add (a:int,b:int):int { }
    ```

They type should always come after the identifier as `:type`. In order to satisfy both mine and the author's requirements here is some experimental syntax for functions and other definitions. I assume people would _loathe_ this with a passion.

## Function

The only difference below is that the function name, and type, come after the parameters. Silicon uses commas to help visually separate parameters AND no comma means that is the function name/identifier. This means no parens or brackets of any kind are needed.

#### CURRENT

    @fn add:int a:int, b:int = {
        a + b
    }

#### EXPERIMENTAL

    // int, int -> int
    @fn a:int, b:int add:int = {
        a + b
    }

Type definition with generic parameter

    // generic list
    @type 'T List = {
       item:T
       next:->List
       prev:->List
    }

#### EXPERIMENTAL 2

Closer to ML syntax using `@let` for all binding definitions.

**Function**

    // yuck
    @let add = @fn a:int, b:int _:int {
        a + b
    }

**Type**

    @let person:struct = @struct a:type {
        name:string
        age:int
    }

## Traits

```silicon
    @type stringy:@interface 'Type = {
        @fn to_string:string a:Type
    }

    @type stringy:@impl int = {
        @fn to_string:string a:int = {
            // ...code...
        }
    }
```

### Traits with output named last

```silicon
    @type 'Type stringy:@interface = {
        @fn to_string:string a:Type
   }

    //TODO: not sure which to use. Second is clearer imho.
   //@type int stringy:@impl
   //@impl int string:@interface
    @impl int stringy:@interface = {
        @fn to_string:string a:int = {
            // ...code...
        }
    }
```

## Classes vs Data Types?

I'm debating on going the more OOP route, which is what `R#st` and `Go` do with `Person::new()` and `Person.new()`, respectively.

I'm using `$()` for a list of values, since `()` just groups expressions normally. Maybe I can remove or that will be tuple syntax?

Using a class to define a `Person`.

```
    @class Person name,age,friend = {
        name:string,
        age:int,
        friend:->Person,
    }

    @impl Person self = $(

        @fn Greet name = {
            #print `Hello, ${name}`
        },

        @fn addFriend friend:Person = {
            self::friend
        }
    )
```

## Objects vs Statement groups?

How to disambiguate `{}` for key, value pairs and code blocks?

```
    // similar to OCaml data types. No Names required.  // types are still always :type
    @type Person = :string, :int, :Person

    @type Person =
        (name   :string = "Jane Doe",
         age    :int = 29,
         friend :-> Person? = $NONE)

    @fn Greet self:Person, name = {
        #print `Hello, ${name}`
    }

    @fn addFriend self:Person, friend = {
        #self.friend.add friend
    }

    // sorta like a submodule of methods
    // or a namespace but for a specific type

    // instead of @mod?
    @let friends = @impl Person, (/* ...code...*/)
    @impls Person,
   // namespaced method groups?
   // Are they methods if they use UFCS?
   // there is no dispatch?
    @mod friends self:Person = (
        @fn clear = {
            self.friend = $NONE
        },
        @fn addFriend self:Person, friend = {
            #self.friend.add friend
        }
    )

    // OR as a function
    @impl Person, (
        @fn clear self = {
            self.friend = $NONE
        },
        @fn addFriend self:Person, friend = {
            #self.friend.add friend
        }
    )

    // usage
    // setup
    @let Delfina = Person ("Delfina",29, $NONE)
    @let Jason = Person ("Jason",32, Delfina)

    // Parens for tuple / grouping?
    @let Delfina = #Person $("Delfina",29, $NONE)
    @let Jason = #Person $("Jason",32, Delfina)

    #Delfina.friends.add Jason
    #Delfina.friends.clear

    // This *IS* too much syntax
    #Delfina::friends.add Jason
    #Delfina::friends.clear

```

## Keywords

Silicon only has 20 keywords (Go has 25). Thanks to named parameters many keywords aren't needed like `case` or `default` for switch case.

- @let
- @mut // TODO: mutability keywords?
- @co // TODO: coroutines
- @defer // TODO: implement
- @select //TODO: coroutine select
- @if
- @match
- @for
- @while
- @fn
- @type
- @impl
- @mod
- @import
- @export
- @continue
- @fallthrough
- @break
- @return
- @return_up

AND

- @and
- @or
- @not
- @least
- @most
- @above
- @below
- @between
- @within
- @outside

## Syntax / Symbols

- `$` atoms
- `()` group expressions are expression / key-value pairs
- `[]` list of values
- `{}` statements
- `@` keyword
- `'T` Generic indentifier
- `` `backtick` `` backticks for template strings
- `_` throw away
- `;` end of statement or expression
- `.` field access OR namespace access
- `,` separate lists
-

## Dispatch

Silicon doesn't actually have methods. "WHAT?",¨¿Qué?","что?".

Yeah. There can only be one function with a specific name in any module. Thankfully, we can differentiate them by module and still use a method-like syntax. BUT there is no dispatch. `Silicon Dynamic` _may_ have multiple dispatch though since that is kinda cool to play with in a dynamic language context.

UFCS or universal function call syntax means that you can write a function like a method call but the first parameter is the receiver.

The following example has a `swap` function that takes a string and then swaps all instances of the give pattern with the give value.

```silicon
#swap "Hello, Space", "Space", "World!" // "Hello, World!"

"Hello, Space".swap "Space, "World!" // "Hello, World!"
```

### One name to rule them all

There is only one swap function right? I can't have more than one, function overloading.

## Type-Directed Name Resolution (TDNR)

There was a [proposal to add TDNR to Haskell](https://web.archive.org/web/20160310052223/https://prime.haskell.org/wiki/TypeDirectedNameResolution). This is _REALLY_ interesting for Silicon because this would really sell the language and set it apart from being too FP or too OOP.

```
@mod int = (
    @fn toString:string value:int = { /* ...code... */ }
)

@mod bool = (
    @fn toString:string value:bool = { /* ...code... */ }
)

#toString x // ERROR: ambigous, we don't have function overloading.

// fully-qualified name
int::toString x // correct
bool::toString x // correct

// unqualified name resolution
// if X is of type int then it'll resolve to int::toString
// if X is of type bool then it'll resolve to bool::toString
x.toString

5.toString // "5"
$true.toString // "true"




```
