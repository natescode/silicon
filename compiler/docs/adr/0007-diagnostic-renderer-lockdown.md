# ADR 0007 — Lock the diagnostic pretty-renderer surface for 1.0

- **Status:** Proposed
- **Date:** 2026-05-26
- **Related:** `docs/v1-bootstrap-requirements.html` §4c · `docs/diagnostics.md` · `src/errors/diagnostic.ts`

## Context

`src/errors/diagnostic.ts:6` opens with: *"pretty rendering is throwaway, so
we land the records now and skip the rendering polish."*

The diagnostic **record schema** is final — `phase`, `code`, `span`,
`message`, `hint`, `snippet`, `severity` — and Phase 2 added Levenshtein
hints, caret rendering, `ArityMismatch` (E0009), `MissingReturn` (E0008).
But `renderPretty()` itself is ~20 lines of placeholder.

Re-implementing a *different* style in Silicon is wasteful. Re-implementing
the same throwaway is wasteful. Pick a final style now while editing TS is
cheap.

Four sub-decisions buried inside "lock the renderer":

| Sub-decision | Options |
|---|---|
| Caret style | Rust-style ASCII (`^^^^`) vs ANSI box-drawing (`└──`) |
| Color story | true-color · 256-color · none (force-monochrome 1.0?) |
| Hint formatting | inline `hint:` prefix on the next line · separate block below caret |
| "Did you mean" position | above the caret · below the caret · inline replacement |

## Decision

**Recommendation: Rust-style ASCII carets; 256-color with `NO_COLOR` opt-out
(no true-color, no ANSI box-drawing); inline `hint:` prefix on the line below
the caret; "did you mean" appears as a hint line (so it sits below the caret
with the other hints).**

Concretely:

```
error[E0009]: function `&add` called with 3 args; expects 2
   ╭─ examples/main.si:7:5
 7 │     &add a, b, c
   │     ^^^^^^^^^^^^ wrong arg count
   │
   = hint: did you mean &add3?
```

- Caret line uses `^` (ASCII), not `└──` (ANSI box-drawing).
- Source-context lines use `│` (light box-drawing) — broadly available;
  fallback to `|` when `NO_COLOR` or non-UTF-8 terminal.
- `error[CODE]` prefix in red. File path in bright. Caret in red. Hint in
  cyan with `=` prefix marker.
- 256-color palette, NO true-color. `NO_COLOR=1` env var forces monochrome.
- Sniff `process.stdout.isTTY`; respect `--color=always|never|auto`
  CLI flag if present.

Update `docs/diagnostics.md` with the exact rendering grammar plus a fixture
file (`tests/fixtures/diagnostics/golden.txt`) so future renderer edits show
up as fixture diffs.

## Options considered

### Option A — Lock Rust-style ASCII *(recommended)*

Cost: ~3 hours including fixture authoring.

- Pro: familiar to most users (cargo, clippy, rustc)
- Pro: ASCII renders identically everywhere
- Pro: 256-color is universally supported; true-color isn't
- Con: less visually distinctive than ANSI box-drawing

### Option B — Lock ANSI box-drawing (Roc-style)

- Pro: visually distinctive; matches Roc's design language
- Con: fixture authoring is heavier; some terminals (Windows PowerShell pre-2019, some CI envs) render poorly
- Con: doesn't materially help debugging

### Option C — Ship two renderers (`--diagnostic-style=ascii|fancy`)

- Reject. Doubles the renderer surface for ~0 user value.

### Option D — Leave it throwaway; lock in v1.1

- Reject. Premise of this ADR is that re-doing the same throwaway in
  Silicon costs more than picking the final form now.

## Consequences

- **Positive (A):** renderer ships once; the future self-hosted compiler ports it once
- **Positive (A):** `tests/fixtures/diagnostics/` becomes the regression
  net — any unintended renderer change shows up as a fixture diff in CI
- **Negative (A):** small risk of "we should have picked fancy" later, but
  that's a v2.0 concern, not v1.1
- **Follow-up work:**
  - Golden-file fixture suite for each diagnostic code
  - `NO_COLOR` env handling
  - `--color` CLI flag plumbing

## Implementation pointer

Pending — link the PR that lands the locked renderer and updates
`docs/diagnostics.md` with the rendering grammar.
