## Comments

### C style comments

    // single line comment

    /*
        Multi-line
        Comment
    */

### Doc Comments

Starts a line with `///`

Doc comments are used for Sigil's built-in auto documentation feature.
They can define function type signatures as well if the function doesn't have types.

Silicon functions have implicity returns. `@exit` can be used a the return keyword.

```silicon
/// number, number -> total:number
@let add a,b = {
    a + b
}
```
