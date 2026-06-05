# docs

The source-of-truth documentation for Sigil / Silicon. The published
docs site at [`site/`](../site/) renders these pages; keep edits here
and let the sync script propagate them.

If you're new, start with [`getting-started.md`](getting-started.md).

## Guide — learning materials

| File | What's in it |
|------|--------------|
| [getting-started.md](getting-started.md) | 15-minute install-to-running-program walkthrough |
| [targets.md](targets.md) | WASM vs native targets — I/O, string layout, `@extern` patterns |
| [memory.md](memory.md) | Arenas, `with_arena`, parent-arena escape, `Rc<T>` |
| [strata-authoring-guide.md](strata-authoring-guide.md) | Step-by-step for writing a new stratum |

## Reference — language and compiler

| File | What's in it |
|------|--------------|
| [grammar.ebnf](grammar.ebnf) | ISO/IEC 14977 EBNF grammar (authoritative) |
| [hm-lite.md](hm-lite.md) | Type inference reference (HM restricted to declared polymorphism) |
| [diagnostics.md](diagnostics.md) | Error-code catalogue, caret rendering, hint format |
| [strata.md](strata.md) | Strata system — how `@stratum` dispatches to pipeline phases |
| [strata-2.0-spec.html](strata-2.0-spec.html) | Strata 2.0 capability specification (implemented) |
| [compiler-api.md](compiler-api.md) | The `&Compiler::*` surface that strata bodies call |
| [compiler-as-a-service.md](compiler-as-a-service.md) | The library-first compiler API (Roslyn-style) |
| [caas-roslyn-parity.md](caas-roslyn-parity.md) | CaaS gap tracker — what's left to reach Roslyn-level IDE API coverage |
| [js-string-builtins.md](js-string-builtins.md) | The `JSString` type, WASM JS String Builtins, and the web/bun platform (`--platform`) |
| [api-boundaries.md](api-boundaries.md) | Per-subsystem import rules; public vs internal |
| [struct-design.md](struct-design.md) | `@struct` design and layout rules |
| [extern-out-pointer.md](extern-out-pointer.md) | `@extern` out-pointer ABI |
| [struct-ffi.md](struct-ffi.md) | Struct-by-value FFI design proposal (not yet implemented) |
| [signature-lines.md](signature-lines.md) | Separate `\\ name: type` signature lines; bare params, externs-as-signatures (proposal) |
| [signature-lines-migration.md](signature-lines-migration.md) | Codemod + phased rollout plan for the signature-lines change (proposal) |
| [use-includes.md](use-includes.md) | `@use 'path.si';` resolution semantics |
| [comptime-via-compilation.md](comptime-via-compilation.md) | The Zig-style comptime engine design |
| [lockfile-format.md](lockfile-format.md) | `sgl.lock` format spec (story 6b-13) |
| [qbe-self-host-plan.md](qbe-self-host-plan.md) | The chosen long-term plan: self-host Silicon to native via QBE, retiring Bun (proposal) |
| [replacing-bun.md](replacing-bun.md) | Cheap interim: drop Bun from the shipped binary via Deno `compile` (proposal) |

## Stability — what's promised, what isn't

| File | What's in it |
|------|--------------|
| [stability.md](stability.md) | Stable / unstable / will-not-be-added surfaces per layer |
| [security.md](security.md) | Threat model + disclosure address (story 10b-4) |
| [performance.md](performance.md) | 1.0 perf baseline + regression methodology (10b-5) |
| [adr/](adr/) | 10 Architectural Decision Records |

## Roadmap — what's planned

| File | What's in it |
|------|--------------|
| [v1-user-stories.html](v1-user-stories.html) | v1.0 story tracker — all closed as of 2026-05-28 |
| [v1.1-user-stories.html](v1.1-user-stories.html) | v1.1 work — LSP, package registry, interpreter, etc. |
| [language-server-plan.html](language-server-plan.html) | LSP — original v1-alpha design record (shipped + superseded; see caas-roslyn-parity.md E3) |
| [silicon_standard_library_v_1.md](silicon_standard_library_v_1.md) | Design target for the v1.x stdlib expansion |
| [aaa-big-plan.md](aaa-big-plan.md) | Short planning note (working draft) |

## Launch + release artefacts

| File | What's in it |
|------|--------------|
| [launch/1.0-announcement.md](launch/1.0-announcement.md) | Long-form blog post for the 1.0 launch |
| [launch/submissions.md](launch/submissions.md) | HN / Reddit / Lobste.rs / Mastodon distribution checklist |
| [release/](release/) | Changesets workflow + per-release notes |

## Non-engineering

| File | What's in it |
|------|--------------|
| [investor-pitch.html](investor-pitch.html) | Pitch deck (non-engineering audience) |

## Historical / archived

[`archive/`](archive/) holds documents that no longer describe how the
compiler works — the boot/ era bootstrap plans, shipped-design docs
whose content has been absorbed into the live reference, and explicit
"brainstorming" docs that were never implemented. See
[`archive/README.md`](archive/README.md) for the index and the
re-activation protocol.

## Editing

- All Markdown is GitHub-flavoured; HTML files are self-contained
  pages with inline styling (no external CSS).
- The site at `site/src/` re-renders these via
  `site/scripts/sync-docs.ts`; update that script's `SYNCS` table
  when you add a new page that should appear on the published site.
- ADRs use the template at [`adr/0000-template.md`](adr/0000-template.md).
- For new launch / release notes, follow the structure of the existing
  files under `launch/` and `release/`.
