---
title: Writing a stratum
---

# Writing a stratum

Suppose you want a new keyword `@count` that logs every definition site
its registered for. Three lines in a `.si` file:

```silicon
@stratum CountDecls := {
    &Compiler::register::keyword '@count';
    &Compiler::on::decl '@count', CountDecls_on_decl;
    &Compiler::on::module_finalize CountDecls_on_finalize;
};

@fn CountDecls_on_decl _node:Int := {
    &state::stratum::set 'seen', (&state::stratum::get 'seen') + 1
};

@fn CountDecls_on_finalize := {
    &Compiler::diag::warn 'S0001', {},
        (&format "@count saw {} definitions", &state::stratum::get 'seen')
};
```

Now anywhere in user code:

```silicon
@count add a:Int, b:Int := { a + b };
@count square n:Int := { n * n };
```

…compiles cleanly and emits one warning at module-finalize time:
`@count saw 2 definitions`.

The compiler never special-cases `@count`. The dispatch is data.

[Full reference: Strata system →](/reference/strata) ·
[Authoring guide →](/guide/strata)
