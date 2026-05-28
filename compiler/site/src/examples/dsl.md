---
title: Strata as design solvent
---

# Strata as design solvent — a tiny DSL

The phrase "strata as design solvent" comes from the project memory:
when the answer might be "add a new compiler feature," first ask if it
can be a stratum + a per-target stdlib shadow tree instead.

Example. Suppose you want a `@table` keyword for declaring lookup
tables that lower to constant globals:

```silicon
@table Days := { Mon = 1, Tue = 2, Wed = 3, Thu = 4, Fri = 5, Sat = 6, Sun = 7 };
```

That's not in the language. You write the stratum:

```silicon
@stratum Table := {
    &Compiler::register::keyword '@table';
    &Compiler::on::decl '@table', Table_on_decl;
};

@fn Table_on_decl node:Int := {
    # Walk the node's body, for each "key = value" entry:
    #   &Compiler::module::push_global key, IR_const(value);
    # … using &Compiler::ast::* to read the body shape.
};
```

The compiler never grew a feature; the user grew the language. The
shape of every other Silicon definition is unchanged.

This is the most under-marketed thing about Silicon. Most "I wish my
language had X" wishes turn into strata.

[Pattern reference: strata-as-design-solvent (memory entry) →](https://github.com/NatesCode/sigil/blob/main/CLAUDE.md)
