## Annotations `@@`

Silicon doesn't have built-in modifiers like `public`,`private` etc. Both because it is not
an OOP language and because modifiers would have to be _annotations_.

Annotations do use a new **sigil** `@@`.

    @@my_annotation
    @let x = 42;

Annotations provide a lot of flexibility in the language.

## Identity & Equality

Taken form [karlsruhe](https://soc.me/languages/equality-and-identity-part3)'s blog.

### Defining Equality and Identity

- **Equality** checks whether two things are equal, based on some library-defined definition of equality.

- **Identity** checks whether two things are identical, based on a built-in definition of identity."

Every language has a way to compare things. There are two types of comparison though: referential equality and value equality.

`==` and `@eq` - checks whether two things are equal, based on some library-defined definition of equality.

`===` and `@is` - checks whether two things are identical, based on a built-in definition of identity.

`equality` = **language** definition.

`identity` = **user / library** definition.

So by default a type doesn't have `identity` defined i.e.

> only available when the type is constrained appropriately

    @fn same[E : Identity](a: E, b: E) = { a === b }
