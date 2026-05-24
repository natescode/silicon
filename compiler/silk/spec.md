# Silk — Language Specification

> **Status:** draft. This document is the canonical reference for the language; conflicts with prose elsewhere should be resolved in favor of this file.

## 1. Goals & non-goals

Silk exists for two reasons:

1. **Multi-target code generation.** One Silk file can lower to different language / framework / database combinations without rewriting domain logic.
2. **Trainability.** Silk is small and uniform on purpose. An LLM that learns the syntax once generalizes across the whole language. Constraint is the design principle, not a limitation.

The non-goals are equally deliberate:

- Silk is **not** a general-purpose programming language. Arbitrary computation belongs in the target backend.
- Silk is **not** optimized for human elegance. Uniformity beats prose.
- Silk is **not** Turing-complete inside any single block. The flow DSL is intentionally finite-state-machine-shaped.

## 2. Syntax

Silk has exactly one syntactic form:

```
form    ::= ( kind name kwargs body )
kwargs  ::= ( :key value )*
value   ::= atom | list | form
body    ::= form*
```

**Atoms** are identifiers, strings (`"..."`), integers, decimals, and the predefined symbols `true`, `false`, `nil`.

**Lists** are parenthesized sequences with no head reserved word — used for parameter lists, field tuples, etc.

**Comments** start with `;;` and run to end-of-line.

### Naming conventions

| Category | Convention | Example |
|---|---|---|
| Identifiers, fields | `kebab-case` | `book-id`, `created-at` |
| Declared types, contracts | `PascalCase` | `Order`, `PaymentProcessor` |
| Events, commands | `PascalCase` | `OrderPlaced`, `Checkout` |
| Enum variants | `PascalCase` | `Pending`, `Shipped` |
| Keywords | `:lower-kebab` | `:input`, `:auth`, `:idempotency-key` |

A validator should enforce these — mixed conventions are an LLM-training hazard.

## 3. Block kinds

There are 17 reserved heads. Every form starts with one of them.

| Stratum   | Kind         | Purpose                                         |
|-----------|--------------|-------------------------------------------------|
| System    | `system`     | top-level container; targets, concerns          |
|           | `service`    | bounded context; owns entities, exposes contracts |
|           | `module`     | code-organization unit within a service         |
| Domain    | `entity`     | persisted aggregate with identity               |
|           | `value`      | immutable structured data; no identity          |
|           | `enum`       | payload-free tagged variants                    |
|           | `event`      | something that happened (past tense)            |
|           | `command`    | something requested (imperative)                |
| Behavior  | `contract`   | externally-visible interface                    |
|           | `operation`  | named behavior with input/output/effects        |
|           | `flow`       | ordered steps; used inline via `:flow`          |
|           | `step`       | reusable named step (rare; prefer inlining)     |
| Binding   | `impl`       | implementation of a contract on a provider      |
| Saga      | `saga`       | cross-service compensation block                |
| Atomicity | `transaction`| within-DB atomic block                          |
| Misc      | `record`     | inline structural type (see §4)                 |
| Escape    | `raw`        | target-specific literal (signals missing verb)  |

### 3.1 `system`

```lisp
(system Bookshop
  :description "Online bookstore"
  :targets   (typescript-node postgres)
  :concerns  (auth observability rate-limit))
```

A `system` is the root. `:targets` is a list of `(language framework storage …)` tuples a backend can match against. `:concerns` are cross-cutting features the renderer should weave through every operation.

### 3.2 `service`

```lisp
(service Catalog
  :system    Bookshop
  :exposes   (CatalogAPI)         ; contracts implemented
  :owns      (Book BookReview))   ; entities this service is authoritative for
```

Services are the unit of deployment and ownership. An entity belongs to exactly one service; cross-service reads go through contracts.

### 3.3 `entity`, `value`, `enum`

```lisp
(entity Book
  :service Catalog
  :fields  ((id      uuid   :pk)
            (isbn    string :unique)
            (title   string)
            (author  string :index)
            (price   money)
            (stock   int    :default 0))
  :invariants
    ((stock-nonneg   (>= stock 0))
     (price-positive (>  price 0))))

(value Address
  :fields ((line1   string)
           (city    string)
           (region  string)
           (postal  string)
           (country string)))

(enum OrderStatus
  :variants (Pending Confirmed Fulfilling Shipped Cancelled))
```

Entities have identity, persistence, and invariants. Values have neither identity nor persistence — they're substituted by structure. Enums are payload-free tagged variants. (For sum types with payloads, see `value` with `:variants` — deferred from current spec.)

Field attributes: `:pk`, `:unique`, `:index`, `:default <expr>`, `:optional`.

### 3.4 `event`, `command`

```lisp
(event OrderPlaced
  :payload ((order-id    uuid)
            (customer-id uuid)
            (total       money)))

(command Checkout
  :payload ((cart-id         uuid)
            (customer-id     uuid)
            (idempotency-key string)))
```

Events are past-tense facts; commands are imperative requests. Both have nominal payloads (no inline `record`).

### 3.5 `contract`, `impl`

```lisp
(contract PaymentProcessor
  :methods ((charge :input ((amount money) (customer uuid))
                    :output ChargeId
                    :throws (Declined))))

(impl StripePayments PaymentProcessor
  :provider stripe
  :config   ((api-key :env STRIPE_SECRET))
  :map      ((charge -> stripe.PaymentIntents.create)))
```

A contract is an interface; `impl` is the binding to a concrete provider. Multiple `impl`s of the same contract coexist for runtime selection.

### 3.6 `operation`

```lisp
(operation OperationName
  :service ServiceName
  :input   ((param Type) …)
  :output  ReturnType
  :effects (db-write event-emit payment …)
  :errors  (ErrorVariant …)
  :auth    (authenticated :owns customer-id)
  :flow    <flow-body>)
```

`:effects` declares observable side effects; the validator uses it to reject operations that perform effects they didn't declare. `:errors` declares the closed set of error variants the operation can raise.

## 4. Type system

### 4.1 Built-in types

| Name | Description |
|---|---|
| `int`, `int32`, `int64` | signed integers |
| `decimal` | arbitrary-precision decimal |
| `money` | decimal with currency tag |
| `string` | UTF-8 |
| `bool` | true / false |
| `uuid` | RFC 4122 |
| `timestamp` | instant in time |
| `duration` | length of time, e.g. `(duration 30s)` |
| `bytes` | opaque binary |
| `(list T)`, `(option T)`, `(map K V)`, `(set T)` | type constructors |

### 4.2 Nominal default, structural escape

**Nominal references are required** at every boundary:

- `entity :fields`
- `event :payload`
- `command :payload`
- `contract :methods` input/output
- Any reference from another service

**Structural `(record …)` is permitted** for one-shot shapes:

- `operation :output` of an internal operation
- `operation :input` parameter type
- Local `:as` bindings inside a flow

```lisp
;; nominal — the default
:output Book

;; structural — local return shape, doesn't deserve a name
:output (record (title string) (author string) (in-stock bool))
```

### 4.3 No structural-to-nominal coercion

A `(record (id uuid) (title string))` does **not** satisfy `Book` even if `Book` has those exact fields. Conformance must be explicit — reference `Book` by name from the start, or use `(coerce x :to Book)`.

This is a hard rule: implicit conformance creates two semantically-identical surface forms, which is poison for LLM training.

### 4.4 Promotion rule

A structural shape that appears more than once in the corpus is a refactor signal. Tooling should detect identical `(record …)` shapes used in N+ places and recommend promotion to a named `value`. This is the same shape as the `raw → verb` promotion rule from the flow DSL — **the language grows from observed patterns, not upfront speculation.**

## 5. The flow DSL

`:flow` accepts a sequence of step verbs. The verb set is closed at 17 forms.

### 5.1 Data verbs

| Verb | Shape | Purpose |
|---|---|---|
| `load` | `(load Type :by field :as name [:else Error] [:optional])` | fetch one row |
| `insert` | `(insert Type :field val … :as name)` | create one row |
| `update` | `(update name :field val …)` | update existing row by reference |
| `mutate` | `(mutate name :field val …)` | in-memory field update on aggregate |
| `delete` | `(delete name)` | delete row by reference |

### 5.2 Control verbs

| Verb | Shape | Purpose |
|---|---|---|
| `if` | `(if cond :then <flow> :else <flow>)` | two-armed branch |
| `when` | `(when cond <flow>)` | one-armed branch |
| `guard` | `(guard cond :else Error)` | early-return on false |
| `return` | `(return value)` | return from operation |

### 5.3 Iteration verbs

| Verb | Shape | Purpose |
|---|---|---|
| `for-each` | `(for-each items :as item <body>)` | iterate, no value |
| `map` | `(map items :as item :to expr :into name)` | iterate and accumulate values |
| `collect` | `(collect value :into name)` | accumulator sub-form inside `for-each` |

### 5.4 Effect verbs

| Verb | Shape | Purpose |
|---|---|---|
| `call` | `(call Contract.method :arg val … :as name [:else Error])` | invoke external operation |
| `emit` | `(emit Event :field val …)` | publish event |
| `compute` | `(compute name expr)` | bind a derived value |

### 5.5 Composition verbs

| Verb | Shape | Purpose |
|---|---|---|
| `parallel` | `(parallel <step> <step> … [:tolerate Errors])` | concurrent execution |
| `transaction` | `(transaction [:isolation L] <flow>)` | within-DB atomic block |
| `saga` | `(saga name :forward <flow> :compensate <flow> [:strategy] [:deadline])` | cross-service compensation; see [saga.md](saga.md) |

### 5.6 Escape

| Verb | Shape | Purpose |
|---|---|---|
| `raw` | `(raw target "literal code")` | last-resort target literal; flags missing verbs |

`raw` use in a corpus is a *signal*, not a feature. Frequent `raw` for the same pattern is a candidate for verb promotion.

## 6. Expression sublanguage

Expressions appear inside conditions, computations, and field values. The sublanguage is **closed** — no user-defined expression functions. If you need one, lift it to an `operation`.

### 6.1 Operators

| Category | Operators |
|---|---|
| Comparison | `==` `!=` `<` `>` `<=` `>=` |
| Arithmetic | `+` `-` `*` `/` `%` |
| Logical    | `and` `or` `not` |

All operators are written in prefix form: `(>= book.stock 1)`, `(* book.price quantity)`.

### 6.2 Field access

Dot notation: `book.stock`, `order.line-items.length`. Resolves through entity / value / record field references and through type-aware properties (`(list T)` exposes `.length`).

### 6.3 Predicates

| Predicate | Meaning |
|---|---|
| `(present? x)` | true if `x` is a non-nil optional |
| `(absent? x)`  | true if `x` is nil |
| `(empty? xs)`  | true if collection has zero elements |
| `(any? xs :where pred)` | true if any element satisfies pred |
| `(all? xs :where pred)` | true if every element satisfies pred |

### 6.4 Collection builtins

| Builtin | Shape |
|---|---|
| `count` | `(count xs)` |
| `sum`   | `(sum xs :by field)` |
| `min`   | `(min xs :by field)` |
| `max`   | `(max xs :by field)` |

### 6.5 Environment builtins

| Builtin | Returns |
|---|---|
| `(now)` | current `timestamp` |
| `(uuid-gen)` | a fresh `uuid` |
| `(current-actor)` | the authenticated principal, if `:auth` declared |

## 7. Saga

`saga` deserves its own document. See [`saga.md`](saga.md) for execution model, semantic rules, strategies, and composition with `transaction`.

## 8. Validation

A static validator must reject:

1. **Undeclared references.** Any nominal name (`Book`, `OrderStatus.Pending`, `PaymentProcessor`) must resolve to a declared block.
2. **Unowned mutations.** An operation in service `A` may not `mutate` an entity owned by service `B`. Cross-service writes go through contracts.
3. **Undeclared effects.** An operation that uses `emit` must declare `event-emit` in `:effects`. Same for `db-write`, `payment`, etc.
4. **Undeclared errors.** An `:else SomeError` clause must list `SomeError` in the surrounding operation's `:errors`.
5. **Banned compositions.** `saga` inside `transaction` is rejected. So is `mutate` on a `value` (values are immutable by definition).
6. **Convention violations.** Identifiers in wrong case (e.g., `lowerCamel` for a type name).
7. **Effectful expressions.** Expressions are pure; a `call` cannot appear inside an arithmetic expression. Lift it to a `compute` step.

## 9. Backends

A backend renders Silk into a specific language / framework / storage combination. Each kind has a renderer; each verb has a translation rubric. The backend is responsible for:

- **Idiomatic code.** Generated code should look hand-written for the target.
- **Effect realization.** Mapping `emit` to the chosen event bus, `transaction` to the chosen DB, `saga` to the chosen orchestration mechanism (Temporal, Step Functions, or hand-rolled).
- **Cross-cutting concerns.** Auth, observability, rate limiting — driven by `:concerns` at the `system` level.
- **No semantic changes.** A backend must not silently introduce retry, caching, or other behavior the Silk source didn't ask for.

The IR is the contract. If two backends disagree on what an operation *means*, the spec wins.

## 10. Training corpus

Because Silk is designed for LLM training, the corpus matters as much as the language. Recommended practices:

1. **Cross-validate every example.** A program in the corpus must pass the validator. Broken examples poison training.
2. **Mutate to augment.** Rename a field, add an effect, swap a contract impl, add a saga step — each mutation produces a new valid program with known semantics.
3. **Round-trip.** Train against (Silk → code → Silk) consistency loss in addition to (NL → Silk).
4. **Track `raw` density.** A corpus with many `raw` forms for the same pattern means the language has a gap. Use this to drive verb promotion.

## 11. Versioning

The spec is versioned `(silk N.M)`. `M` increments are additive (new verb, new kind, new builtin). `N` increments may break backward compatibility. Files declare their target version with `(silk-version 0.1)` at the top.

Current version: `0.1`.
