## Identity & Equality

Taken from [karlsruhe](https://soc.me/languages/equality-and-identity-part3)'s blog.

Many languages get this confused or wrong.

### Defining Equality and Identity

- **Equality** checks *value* equality. This may be defined for custom types.

- **Identity** checks *reference* equality.

Every language has a way to compare things. There are two types of comparison though: referential equality and value equality.

`==` and `@eq` - checks whether two things are equal, based on some library-defined definition of equality.

`===` and `@is` - checks whether two things are identical, based on a built-in definition of identity.

`equality` = **language** definition.

`identity` = **user / library** definition.

So by default a type doesn't have `identity` defined i.e.

> only available when the type is constrained appropriately

    @fn same[E : Identity](a: E, b: E) = { a === b }
