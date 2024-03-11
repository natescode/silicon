# Memory Management

\* None of this has been finalized.

Silicon uses [Gradual Memory Management](https://jondgoodwin.com/pling/gmm.pdf).

Silicon also uses [Locality](https://blog.janestreet.com/oxidizing-ocaml-locality/)

Currently, Silicon defaults to ARC (automatic reference counting) but that can be turned off. Here are the following main strategies

- ARC (default)
- Manual (defer)
- Locality (Jane Street OCaml)
- Lifetimes (To be implemented)
- Tracing GC

## ARC

## Manual

## Locality

Inspired by Jane Street's approach. Silicon does locality in reverse though. Since Silicon's default is to _NOT_ GC then `local` is implicit
and only when needed is `ARC` or another strategy used.

OCaml Example

```ocaml
let is_int str =
    let opt = Int.of_string_opt str in
    match opt with
    | Some _ -> true
    | None -> false
;;
```

Let's translate this to `Silicon`

```silicon
@let is_int str = {
    @let opt = str.toInt |>
        (@fn (Some _) = false,
        @fn None = false)
};
```

OCaml by default puts `opt` in the heap because it _could_ escape but in this case it clearly doesn't. Silicon
by default would throw an error because it doesn't know what the developer wants to do.

```silicon
@let is_int str = {
    @let opt = str.toInt |>
        (@fn (Some _) = false,
        @fn None = false)
}
// ERROR: 'opt' semantics not specified. Use `@@local` or ``@@global``.
```

Again, Sigil gives amazing error messages with potential fixes. Practically there would be no compiler error because the LSP would automatically show use red squiggly and suggest we use one of those keywwords. So we have to decide which to use. Since `opt` is a boolean and pretty small let's
stack allocat it, copy semantics. _I **may** have Silicon default to `@@local` here because a boolean is small or perhaps default to ARC_

````silicon
@let is_int str = {
    @@local
    @let opt = str.toInt |>
        (@fn (Some _) = false,
        @fn None = false)
}
// ERROR: 'opt' semantics not specified. Use `@@local` or ``@@global``.
`



`x` never escapes its scope so it will be put on the stack and be local.

```silicon
@fn foo bar = {
    @let x = @if bar $then [10,20] $else [1,2];
    x.len
}
````

What if X does escape? Then by default `ARC` will be used. We can copy by value if we want with `@@val x`

```silicon
@fn foo bar = {
    @let x = @if bar $then [10,20] $else [1,2];

    @@val
    x
}
```
