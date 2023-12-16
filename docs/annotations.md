## Annotations `@@`

Silicon doesn't have built-in modifiers like `public`,`private` etc. Both because it is not
an OOP language and because modifiers would have to be _annotations_.

Annotations do use a new **sigil** `@@`.

    @@my_annotation
    @let x = 42;

Annotations provide a lot of flexibility in the language.

## DSL / Macros

Annotations can define macros like `HTML!` in Rust.

    @@@html `<h1>${title}</h1>
             <p>${body}</p>`
