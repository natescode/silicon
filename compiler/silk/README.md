# Silk

An S-expression intermediate representation for software architecture and code.

Silk describes *what* a system is and *what* it does, leaving *how* to render it in a target language to pluggable backends. A single Silk file can lower to TypeScript + Postgres, Python + SQLAlchemy, Go + Spanner, or any other combination, with the same domain semantics.

The language is deliberately small — one syntactic shape, ~17 block kinds, ~17 flow verbs, and a closed expression sublanguage. Smallness is a feature: the design target is **trainability** for LLM-driven code generation, where a narrow surface beats expressive cleverness.

## Quick taste

```lisp
(operation PurchaseBook
  :service Orders
  :input   ((customer-id uuid) (book-id uuid) (quantity int))
  :output  Order
  :errors  (OutOfStock UnknownBook PaymentDeclined)
  :flow
    (load    Book :by book-id :as book :else UnknownBook)
    (guard   (>= book.stock quantity) :else OutOfStock)
    (compute total (* book.price quantity))
    (call    PaymentProcessor.charge
             :amount total :customer customer-id
             :as charge :else PaymentDeclined)
    (transaction
      (mutate book :stock (- book.stock quantity))
      (insert Order :customer-id customer-id :book-id book-id
                    :total total :as order))
    (emit OrderPlaced :order-id order.id)
    (return order))
```

## Documents

- [`spec.md`](spec.md) — full language specification (block kinds, flow verbs, type system, expression sublanguage)
- [`saga.md`](saga.md) — semantics of cross-service compensation via `saga`
- HTML versions: [`spec.html`](spec.html), [`saga.html`](saga.html)

## Examples

- [`examples/bookshop.silk`](examples/bookshop.silk) — small bookstore (POC)
- [`examples/checkout.silk`](examples/checkout.silk) — realistic distributed checkout with sagas

## Design principles, restated

1. **One shape.** Every form is `(kind name :key value :key value … body)`. A model learns it once, then generalizes.
2. **Above syntax.** Silk describes domain semantics, not language idioms. Backends render idiomatic code per target.
3. **Nominal by default.** Cross-boundary types must have names. Structural `(record …)` exists as a local escape, with a promotion rule when it appears twice.
4. **Closed expression sublanguage.** A fixed list of operators, predicates, and builtins. No user-defined expression functions; lift to an `operation` instead.
5. **Promote from the corpus, not from speculation.** New verbs and named types come from observed patterns in real Silk code, not from upfront guesswork.

## Status

Design draft. No reference implementation yet. The next milestones are:

1. A static validator (rejects undeclared names, mismatched arities, banned compositions).
2. A reference backend (TypeScript + Postgres) to prove the lowering model.
3. A corpus generator that mutates valid programs to produce training data.
