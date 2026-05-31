# 1.0 Launch — distribution checklist

Companion to `1.0-announcement.md`. Concrete copy for each channel; tick
each box on launch day.

## Hard prerequisites

- [ ] `v1.0.0` git tag pushed; GitHub Release artefacts built and
      verified (10c-1, 10c-8).
- [ ] Acceptance gate green (10c-9): `brew install …/sgl &&
      sgl init test && cd test && sgl run` succeeds on a clean macOS
      VM and a clean Linux VM.
- [ ] Docs site reachable at its production URL (10c-10).
- [ ] `CHANGELOG.md` 1.0.0 section landed on `main` (10c-11).
- [ ] Launch post published at the docs site (or natescode.com) —
      submissions below all link to it.

## Hacker News

**When:** Tuesday–Thursday, ~07:30 Pacific. Personal account. Don't
submit during peak hours; quality readers, not algorithmic boost.

**Title:** `Silicon 1.0 — a WebAssembly-targeting systems language where features are data`

**URL:** Link to the docs-site blog post (preferred) or the GitHub
release page.

**First comment** (post within 5 min of submission so it's visible):

> Author here. Silicon is a programming language whose differentiator
> is that every operator, control-flow construct, and definition
> keyword in the language is defined as Silicon source under
> `src/strata/` rather than as a switch case in the compiler. The
> reference compiler (Sigil) targets WebAssembly directly and, via
> QBE, native binaries on Linux + macOS.
>
> Happy to answer questions about the design, the trade-offs against
> Zig / Rust / Roc, what 1.0 deliberately ships without (LSP, package
> registry, incremental compile — all v1.1 work), or the strata
> mechanism itself.
>
> Full known-limitations list is in CHANGELOG.md; the 15-min walkthrough
> is in docs/getting-started.md.

**Engagement rules:**

- Reply substantively to top-level technical comments within ~2h of
  submission. Don't argue with bad-faith readers; they self-discredit.
- "Why not just X?" answers — point at the blog post's section, then
  add the specific nuance the commenter raised.
- Stay off the meta-thread about HN dynamics. Talk about the language.

## Lobste.rs

**When:** Same window as HN, ~30 min after.

**Tags:** `compilers`, `plt`, `release`, `webassembly`

**Title:** `Silicon 1.0 — language features as data, compiling to WASM + native via QBE`

**Story text** (a few sentences — Lobste.rs prefers brief):

> Silicon 1.0 ships today. The compiler core does not switch on
> keyword names — every operator and control-flow construct is a
> `@stratum` definition in `.si` source. Compiles to WAT/WASM and,
> via QBE, native binaries on Tier 1 Linux + macOS. Comparison
> against Zig/Rust/Roc, known limitations, and install instructions
> in the linked post.

## Reddit — r/ProgrammingLanguages

**Title:** `Silicon 1.0 — language features as data (strata system), compiles to WebAssembly`

**Body** (Reddit norms — more casual; can be longer than Lobste.rs):

> Silicon is a small WebAssembly-targeting systems language whose
> compiler core has no special-case branches for keywords. `@if`,
> `@loop`, `@match`, `@fn`, `@let`, `@struct`, `@type`, `@enum`,
> `@defer`, `@try` — all are defined as Silicon source under
> `src/strata/` and dispatched data-drivenly. Adding `@my_keyword`
> is the same kind of work as writing a function.
>
> 1.0 ships today. HM-lite inference, parametric sum types with
> `@match` destructure, arena memory with parent-arena escape, native
> compilation via QBE on Linux + macOS. No LSP, no package registry,
> no incremental compile at 1.0 — all v1.1 work and called out
> explicitly in the CHANGELOG.
>
> Blog post (with runnable examples and the "why not Zig/Rust/Roc"
> section): [LINK]
>
> Repo: https://github.com/NatesCode/sigil
> 15-min tutorial: docs/getting-started.md

## Reddit — r/programming

**Title:** `Silicon 1.0 — a new WebAssembly-targeting systems language`

**Body:** Strip the PLT-specific framing, lean on the WebAssembly +
QBE-native angle. Cross-post the blog URL.

## X / Mastodon / Bluesky thread

8-post thread. Each ≤ 280 chars. Cross-post to all three.

**1/8.**  Silicon 1.0 is out.  A small systems language that compiles to
WebAssembly and (via QBE) native binaries on Linux + macOS.  The hook:
language features are data, not code in the compiler.  [LINK to blog post]

**2/8.**  Most languages: adding a new operator means editing the parser,
the elaborator, the typechecker, and the lowering pass.

Silicon's compiler core never switches on keyword names.

**3/8.**  Every keyword is a `@stratum` definition in `.si` source.
`@if`, `@loop`, `@match`, `@fn`, `@struct`, `@defer`, `@try` — all
strata.  Adding `@my_keyword` is the same kind of work as writing a
function.

**4/8.**  Example — defining `+` as a stratum:

```
@stratum Plus := {
    &Compiler::register::operator '+';
    &Compiler::on::lower '+', Plus_lower;
};
```

That's it.  The compiler dispatches.

**5/8.**  1.0 includes: parametric sum types, `@match` destructure with
arm-expression form, HM-lite inference, arenas with parent-arena
escape, `Rc<T>`, `@defer`, `@try`, unsigned int types, WasmGC opt-in.

**6/8.**  Distribution: `curl | sh`, Homebrew, apt/deb, winget (Windows
via WSL).  Native via QBE on linux-x86_64 / linux-aarch64 / macos-arm64 /
macos-x64.  Self-host verified.

**7/8.**  Honest about what's missing: no LSP, no package registry, no
incremental compile, no code-action API.  All v1.1 work, all in the
CHANGELOG.

**8/8.**  Install in 60s:

```
curl -fsSL https://raw.githubusercontent.com/NatesCode/sigil/main/scripts/install.sh | sh
sgl init hello && cd hello && sgl run
```

Blog post with the full design rationale: [LINK]
Repo: https://github.com/NatesCode/sigil

## Follow-up posts (drafted but not necessarily published)

- **"This Week in Silicon" cadence post.** Sets up the rhythm for v1.1
  momentum. Publish week 2 only if the launch attracted enough
  interest to make it worth maintaining.
- **Strata authoring tutorial.** Already in
  `docs/strata-authoring-guide.md`; cross-post as a follow-up blog
  post after the launch noise settles.

## What this launch is NOT

No paid promotion. No sponsored posts. No influencer outreach. Silicon's
audience is engineers who read primary sources — the writing is the
marketing.
