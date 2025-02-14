# Comments

## Single Line 

Start wit `#` goes to the end of the line

    # single line comments start with #

## Multi-line

Starts with `##` end with equivalent `##`. Supports nested multi-line comments.

    ##
        Multi-line
        Comments start with 
        and end with 
    ##

## Doc Comments

Special multi-line comments for code documentation.

Starts with `###` and ends with `###`


Doc comments are used for Sigil's built-in auto documentation feature.
They can define function type signatures as well if the function doesn't have types.

Silicon functions have implicity returns. `@exit` can be used a the return keyword.

```silicon
###
    @type number, number -> total:number
    @description adds two numbers together
    @returns sum
###
@let add a,b = {
    a + b
}
```
