# `saga` — Specification

## Purpose

Express **cross-service consistency** by pairing forward actions with compensating actions. The runtime guarantees that on failure, completed forward actions are rolled back in reverse order. Sagas complement `transaction` (atomic within one DB) — they handle the case where atomicity isn't possible because the work spans services.

## Form

```lisp
(saga name
  :strategy   lifo                 ; lifo | explicit | best-effort   (default lifo)
  :deadline   (duration 30s)       ; optional
  :forward    <step-or-flow>       ; required
  :compensate <step-or-flow>)      ; required unless :strategy is explicit
```

`name` identifies the saga for logging, tracing, and reference in error reporting. `<step-or-flow>` is either a single step verb or a sequence of them (same surface as `:flow`).

## Execution model

A saga has three phases:

```
   forward phase ──success──▶ saga completes; bindings escape into surrounding flow
        │
       fail
        ▼
   abort phase ─────▶ compensate phase ─────▶ saga raises; propagates to surrounding flow
                                                (which may compensate its own outer sagas)
```

## Semantic rules

1. **Forward phase.** `:forward` executes top-to-bottom by default. Steps within `(parallel …)` execute concurrently. A step is **committed** when it returns successfully; **in-flight** otherwise.

2. **Failure trigger.** The forward phase aborts on the first uncaught error from any step (including parallel siblings). In-flight parallel steps are cancelled if cancellable, then awaited to settled state before compensation begins.

3. **Compensation order (default `:strategy lifo`).** Only **committed** steps are compensated, in reverse order of commit. Parallel siblings that both committed are compensated in parallel.

4. **The failing step is not compensated.** Convention: either the failing step had no effect, or its `:else` clause handled cleanup. This invariant is load-bearing — if a forward step can fail *after* committing partial state, the step itself must use an idempotency key so its compensation can run safely.

5. **Bindings.** Names bound inside `:forward` (`:as x`, `collect :into xs`) are **visible read-only in `:compensate`**. They're also visible in the surrounding flow *if and only if* the saga succeeds. This makes the saga a value-producing form, not just a control-flow form.

6. **Compensation failure (default `:strategy lifo`).** If a compensation step itself fails, the entire saga raises a `CompensationFailed` error wrapping the original failure and the compensation failure. The surrounding flow's outer sagas still compensate. The system is left in a *known-inconsistent* state — manual reconciliation territory. Backends should emit structured logs at this point.

7. **Idempotency is a requirement, not a guarantee.** Every compensation step *must* be safe to run zero, one, or more times — the runtime may retry, and the failing-step-may-have-committed case (rule 4) demands it. The IR cannot enforce this, but `:undo`-flavored backends should default to retry-with-idempotency-key.

8. **Composition with `transaction`.** A `transaction` *inside* `:forward` is one logical step — it either commits entirely or compensates as a unit. A `saga` *inside* a `transaction` is rejected at validation time: you cannot put a cross-service compensation inside a single-DB atomic block.

9. **Nesting.** Sagas nest. An inner saga that fails compensates its own forward steps first, then raises into the outer saga's forward phase, which then compensates its committed steps (which may include the inner saga's committed completion). Compensation traversal is depth-first reverse-order across the tree.

10. **Parallel forward steps.** Within `(parallel … :tolerate ())` inside `:forward`, all branches run concurrently. If any branch raises, in-flight branches are cancelled, completed branches are awaited, then all *committed* branches are compensated in parallel (no ordering between them, since they had no commit ordering).

11. **Deadlines.** `:deadline (duration N)` bounds the forward phase. On timeout, the saga aborts as if by failure; compensation gets its own implicit deadline of `2× :deadline` (configurable per backend).

12. **Read-only steps don't need pairing.** A `load` or query inside `:forward` doesn't need a corresponding compensation entry — the compensation flow just won't reference it. The runtime tracks every committed step but only invokes compensation for steps that have a corresponding `:compensate` entry. Unmatched committed steps are silently skipped (read-only).

## Strategies

| Strategy | Forward | Compensation | Use when |
|---|---|---|---|
| `lifo` (default) | sequential or `parallel`-marked | reverse-order, parallel-where-parallel-committed, halt on failure with `CompensationFailed` | most cases |
| `explicit` | as written | `:compensate` block runs verbatim, no auto-tracking; author manages partial-failure logic | the LIFO model doesn't fit — e.g., compensation depends on which forward steps committed in a non-trivial way |
| `best-effort` | as `lifo` | as `lifo`, but compensation failures are logged and skipped, not raised | cleanup of external resources where partial cleanup is better than none |

## Out of scope

- **Durable execution across process restarts.** Whether the saga survives an operation crash is a *backend choice* (e.g., Temporal yes, plain TypeScript no). The IR does not specify this; it specifies the failure-time behavior of a single run.
- **Two-phase commit.** Sagas are *the alternative* to 2PC. If you need 2PC, use a transaction.
- **Automatic retry of forward steps.** Per-call retry policy lives on the `call` verb (`:retry (max 3 :backoff exponential)`), not on the saga.
- **Cross-operation saga state.** A saga belongs to one operation. Long-running workflows that span multiple operations use events, not sagas.

## Worked example

```lisp
(operation BookTrip
  :service Travel
  :input   ((customer-id uuid) (flight FlightChoice) (hotel HotelChoice))
  :output  TripBooking
  :errors  (FlightUnavailable HotelUnavailable PaymentDeclined)
  :flow
    (saga booking
      :strategy lifo
      :deadline (duration 45s)
      :forward
        (parallel
          (call FlightAPI.reserve :choice flight :as fres :else FlightUnavailable)
          (call HotelAPI.reserve  :choice hotel  :as hres :else HotelUnavailable))
        (compute total (+ fres.price hres.price))
        (call PaymentProcessor.charge
              :amount total :customer customer-id
              :as charge :else PaymentDeclined)
      :compensate
        (call PaymentProcessor.refund :charge-id charge.id)
        (parallel
          (call FlightAPI.cancel :reservation-id fres.id)
          (call HotelAPI.cancel  :reservation-id hres.id)))

    (insert TripBooking
            :customer-id customer-id :flight-res fres.id
            :hotel-res   hres.id     :charge-id  charge.id
            :as booking)
    (return booking))
```

Walk-through:

- If **`FlightAPI.reserve` fails**: hotel reservation (parallel sibling) is cancelled if cancellable, awaited otherwise. Compensation runs on whichever of {flight, hotel} actually committed. Payment never ran. The operation raises `FlightUnavailable`.
- If **`PaymentProcessor.charge` fails**: both reservations are compensated in parallel (they have no commit ordering between them). Operation raises `PaymentDeclined`.
- If **everything succeeds** but the surrounding `insert` afterwards fails: the saga has already completed; its compensation does **not** run. This is rule 1 — saga compensation only triggers on saga-internal failure. If you want the booking-record insertion to be part of the rollback, move it *inside* `:forward` with its own `:compensate`.

That last point is the most easily-missed semantic. Worth flagging prominently in any training corpus.

## Backend lowering hint

A backend renders `saga` as:

1. A list of `(step-id, compensate-fn)` pairs, populated as forward steps commit.
2. A `try` block around the forward phase.
3. On catch: iterate the list in reverse, invoking each `compensate-fn`. For `parallel` segments, fan out the compensations.
4. On success: discard the list, propagate bindings outward.

Targets with durable workflow engines (Temporal, Cadence, AWS Step Functions) map the structure more directly — each step becomes an activity, the engine handles the compensation tracking. The IR doesn't care which path the backend takes; it only specifies the failure-time *observable behavior*.

## Two rules worth memorizing

For training data and human authors alike:

- **Rule 4** — the failing step is not auto-compensated. Use `:else` for known-fail paths; use idempotency keys for steps that might partially commit before erroring.
- **Rule 5** — bindings only escape the saga on success. If you need a binding visible to the surrounding flow, the step that produces it must be inside `:forward` *and* the whole saga must succeed.

These are the two semantic traps where hand-written sagas typically go wrong.
