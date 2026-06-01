# Definitions

parse → expand → typecheck → lower

> "Declarative language growth via controlled elaboration"



# CoreExpr for "macros" 

One “sharp edge” to watch: control flow as operators

If you allow users to define new infix operators, you’ll eventually get:

operators that want short-circuiting

operators that want lazy evaluation

operators that want pattern-matching-like behavior

If your core is only “Call + Infix”, you’ll be forced to represent control flow as calls, which becomes messy.

So the rule of thumb:

operators can desugar to If/Let/Block

typechecker stays authoritative

That gives you expressive operators without turning the runtime into a macro interpreter."

## AI Docs

