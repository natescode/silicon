---
title: "Security"
---
# Security

This document is Silicon / Sigil's 1.0 security posture. It is **not** a
third-party penetration-test report; it's the "did we ship anything
obviously bad" pass that backs the 1.0 stability contract (see
[`stability.md`](./stability.md), story 10b-4 in
[`v1-user-stories.html`](./v1-user-stories.html)).

## Reporting vulnerabilities

**Do not file security reports as public GitHub issues.**

- Open a private advisory at
  https://github.com/NatesCode/silicon/security/advisories/new, or
- Email `nate@natescode.com` with the subject line beginning
  `[SECURITY] Sigil`.

Expect an acknowledgement within seven calendar days. The project is
single-maintainer; please be patient and please don't disclose publicly
before a fix has shipped (or 90 days have elapsed without a response,
whichever comes first).

## Threat model summary

Sigil is a compiler. Its primary attack surface is **untrusted Silicon
source** processed by a trusted developer on their own machine:

| Surface | Trust level | What can the attacker do? |
|---------|-------------|--------------------------|
| Silicon source file | Untrusted | Compile it. The compiler must not crash, hang, or escape the project root. |
| `sgl` CLI arguments | Trusted (user-controlled) | Standard CLI argument handling; no SUID, no auth tokens. |
| Comptime handlers | Trusted (project author) | Run with host privileges. Documented explicitly. |
| `wit/comptime.wit` host imports | Trusted | Defined by the project. No network. |
| Emitted `.wasm` binaries | Output | Sandboxed by the WebAssembly runtime, not by Sigil. |
| `sgl` shipped binary | Trusted | Ships from GitHub Releases with SHA-256 checksums (10c-1). |

**What Sigil is not trying to defend against:**

- A malicious comptime handler in your own project. Handlers run with
  the host process's privileges; if you compile a Silicon file that
  registers a stratum whose body opens `~/.ssh/id_rsa`, that file gets
  opened. The trust boundary is "did you write or vet the source
  you're compiling," same as Rust's `build.rs`, Zig's `comptime`, or
  any TypeScript project's `postinstall` script.
- A malicious Silicon program run as a compiled WebAssembly module.
  Sandboxing is the runtime's job (wasmtime), not Sigil's.

## 1.0 audit checklist

These checks were performed before the 1.0 tag. Each item is reproducible
from a fresh clone.

### 1. Path traversal — `@use 'path'`

**Code:** `src/modules/useResolver.ts`

**Resolution rule** (file:line accurate as of 1.0):

```
let abs = isAbsolute(raw) ? raw : resolve(baseDir, raw)
```

`@use 'path';` accepts both absolute and relative paths. There is **no
project-root jail.** Relative paths are resolved against the directory
of the file containing the `@use`. Absolute paths are used as-is.

**Posture:** This is by design. A Silicon project is a directory of
files that the developer wrote or vetted. The compiler is not a
sandbox; it's a build tool. `@use '/etc/passwd'` reads `/etc/passwd`
under the developer's UID just like `cat /etc/passwd` would. If a
malicious `.si` file lands in your project, you have bigger problems
than the compiler reading it.

**Mitigations in place:**

- Cycles are detected and rejected (`@use cycle detected: a -> b -> a`).
- Unreadable / missing paths produce a structured error pointing at the
  resolved absolute path, not a stack trace.

**Not in scope for 1.0:** an explicit project-root sandbox (`@use`
denied outside the directory containing `sgl.toml`). This is a future
hardening pass — tracked as a v1.x story if there's demand.

### 2. CLI argument handling

**Code:** `src/sigil_cli.ts:562-668`

The `sgl` arg parser is hand-written, recognises a fixed flag list, and
treats unknown flags as a hard error (`sgl: unknown flag 'X'`).
Positional arguments are passed through to `cmdBuild` / `cmdRun` /
`cmdCheck` / `cmdFmt` which `fs.readFile` them.

**Audit findings:**

- No shell-out — `sgl` does not invoke the user's shell with arguments
  derived from CLI input.
- No `eval` — arguments are not interpreted as code.
- File arguments are passed to `fs.readFile` directly. Absolute path
  injection (`sgl build /etc/passwd`) reads the file under the
  developer's UID; the compiler then attempts to parse it and produces
  a structured parse error. No privilege escalation.
- `--max-heap=N` parses via `parseMaxHeap` which validates the input is
  an integer; junk produces a clean error and `exit 1`.
- `--target=…` validates against `host | wasix | wasm-gc`; unknown
  values produce a clean error and `exit 1`.

### 3. Comptime sandbox

**Code:** `src/comptime/`, `wit/comptime.wit`

Comptime handlers (stratum bodies) execute in the host TypeScript
process. They are **not sandboxed.** The host import surface is the
`&Compiler::*` API documented in `docs/compiler-api.md` and locked down
in `wit/comptime.wit`.

**What handlers can do:**

- Read source positions, types, IR.
- Push new definitions, globals, diagnostics.
- Call the `&Compiler::diag::error` / `warn` surface.

**What handlers cannot do:**

- Open arbitrary host file paths via `&Compiler::*` (there is no
  `&Compiler::fs::*` surface).
- Open network sockets (no `&Compiler::net::*`).
- Mutate the host process's environment variables (no
  `&Compiler::env::*`).

**Caveat:** the host process running the handler can do all of the
above — but the handler can only ask for what `wit/comptime.wit`
exposes. The trust boundary is the import surface, not the language.

### 4. Input fuzzing

**Suite:** `tests/fuzz/parser.fuzz.test.ts`

Three targets, 60-second budget per target (configurable via
`SIGIL_FUZZ_BUDGET_MS`):

- **Random bytes** — arbitrary `Uint8Array` decoded as UTF-8.
  Default 800 runs.
- **Random token streams** — sequences of valid tokens joined by
  spaces. Default 800 runs.
- **Generative round-trip** — generates small valid Silicon over the
  Int / `@let` / bin-op subset; parses, pretty-prints, re-parses.
  Default 400 runs.

**Acceptance:** Parser **must not** throw an unstructured exception,
crash, loop, or allocate unbounded memory. Structured `Parse error: …`
results are fine. Minimised reproducers committed to
`tests/fuzz/corpus/` as permanent regression seeds.

**Current corpus:** `empty-program.si`, `trailing-semis.si`,
`unicode-mid-input.si`. New seeds added whenever a fuzz run surfaces a
real bug.

**CI:** `.github/workflows/fuzz.yml` runs the suite on every push.

### 5. WASM emit safety

The compiler emits WebAssembly modules whose `import` section is
derived from explicit `@extern` declarations and the embedded
`std.wat`. No implicit host imports are introduced by the codegen path
beyond:

- WASI-style `wasi_snapshot_preview1` imports when WASI bindings are
  declared.
- The single `(import "env" "memory" (memory $mem 1))` exposed by
  `std.wat` for the bump allocator.

**Verification:** for the v1.0 reference programs
(`examples/hello.si`, the stdlib tests, the WasmGC cross-target suite),
the emitted `(import …)` list was manually diffed against the
`@extern` declarations in each source. No discrepancies. Future
codegen changes are guarded by the `src/e2e/` golden tests — adding a
new implicit import requires updating those goldens.

### 6. Dependency audit

```
npm audit --omit=dev    →  0 vulnerabilities
bun audit               →  0 vulnerabilities
```

The `ohm-js` / `@ohm-js/cli` toolchain — and its transitive advisory
graph (`fast-glob → micromatch → picomatch`, `braces`) — was removed
when the parser became a hand-written, dependency-free recursive-descent
parser. There is no longer any grammar-regeneration step.

**Production deps** (`binaryen`, `wabt`): clean.

### 7. Release artefact integrity

- GitHub Releases publishes SHA-256 checksums alongside every tarball
  (`.github/workflows/release.yml`).
- The `curl | sh` installer (`scripts/install.sh`) verifies the
  checksum before installing.
- Homebrew formula carries pinned SHA256 digests for each platform
  (`packaging/homebrew/sgl.rb`).
- The release workflow runs on GitHub-hosted runners; no third-party
  signing infrastructure today.

**Not in scope for 1.0:**

- Sigstore signatures on the release artefacts.
- SBOM generation.
- Reproducible builds.

These are v1.x hardening items; tracked once there's demand.

## Out of scope

Explicitly excluded from the 1.0 security pass:

- **Third-party pentest.** Will commission one if Sigil reaches the
  user base that justifies it. Until then, the audit checklist above is
  the contract.
- **Formal verification of the typechecker.** Academic work, not 1.0
  scope.
- **Codegen fuzzing.** The parser is fuzzed; the codegen is
  golden-tested. Property-based codegen fuzzing is a v1.x story.
- **Supply-chain hardening beyond checksums.** No Sigstore, no SLSA
  level claims at 1.0.

## Change log

| Date | Change |
|------|--------|
| 2026-05-28 | Initial document — 1.0 security pass (10b-4). |
