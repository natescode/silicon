# Technical plan — properly supporting `Bun.$` (shell) over the FFI

> **Status:** proposal — optional **post-v1.0** work, not on any gate.
> **Context:** `Bun.$` is **officially excluded from the v1.0 FFI coverage
> gate**: the gate reads **100%\*** (379/379 bindable members bound), and the
> asterisk is exactly this exclusion (see
> [`ffi-coverage-gaps.md`](ffi-coverage-gaps.md)).  It is **correctly skipped**
> by the bindgen as a tagged-template function — a JS syntactic form, not a
> callable member. This plan adds the capability via a hand-authored runtime
> path, without changing the generator, if/when the shell surface is wanted.

## TL;DR

- **Keep the bindgen skip of `Bun.$`.** A tagged template is a *syntactic form*,
  not a normal callable; forcing the generator to emit an `@extern` for it would
  make the generator dishonest and still require all the host-side work below.
- **Add one general host primitive** — `js::tagged(tag, parts, exprs)` — that
  invokes any tagged-template function with the `.raw` array set host-side.
  This unlocks the *whole* family: `Bun.$`, `Bun.sql`, `String.raw`, `css`, `gql`.
- **Add a bun-only `shell.si` stdlib** over it: a `@suspending` `shell::run`,
  `ShellOutput` readers, ergonomic `sh*` sugar, and `shell::escape`.
- **Security is the design driver.** `Bun.$`'s entire safety value is that each
  `${substitution}` is auto-escaped to exactly one shell argument. That guarantee
  survives the FFI **iff** the literal *segments* and the runtime *substitutions*
  stay separate all the way to the call. Any single-string `sh(cmd)` API destroys
  it and is **rejected**.

---

## 1. What `Bun.$` is, and why the bindgen skips it

`Bun.$` runs shell commands as a **tagged template**:

```js
const { stdout, exitCode } = await $`ls ${dir}`;
```

Its real signature is `$(strings: TemplateStringsArray, ...expressions): ShellPromise`.
The first argument must be a `TemplateStringsArray` — an array of the literal
command *segments* that **also carries a `.raw` property**. Calling it with a
plain array throws (empirically, on Bun 1.3.14):

```
Error: Please use '$' as a tagged template function: $`cmd arg1 arg2`
```

A normal `@extern` models `accessor.method(args)` calls; it cannot reproduce what
the JS parser does when it desugars `` $`…` `` (split the literal into segment
arrays and attach `.raw`). So the bindgen detects a `TemplateStringsArray` first
param and skips it (`compiler/bindgen/src/adapters/dts.ts`, `trySig`). **That skip
is correct and should stay** — see §6.

## 2. The security constraint (the design driver) — empirically proven

`Bun.$` auto-escapes substitutions: each `${expr}` becomes exactly **one** shell
argument and is never re-parsed by the shell. Verified on Bun 1.3.14:

| Call | stdout | Injected command ran? |
|---|---|---|
| `` $`echo ${'a; touch /tmp/PWNED'}` `` | `a; touch /tmp/PWNED` (literal) | **No** — file never created |
| `Bun.$(withRaw(['echo ', '']), 'a; touch /tmp/PWNED')` | `a; touch /tmp/PWNED` (literal) | **No** — escaping survives the hand-built form |
| `Bun.$(withRaw(['echo a; touch /tmp/PWNED']))` | two commands run | **Yes** — baked into the *segment*, so injected |

**The takeaway:** escaping depends *entirely* on keeping runtime data in the
**substitution slots**, never in the template **segments**. This is preserved
across the FFI as long as the binding carries segments and substitutions as
**separate** arrays. The moment any value is concatenated into a segment string,
Bun cannot escape it → shell injection.

> This is why a `sh(cmd: String)` binding (build the whole command as one string)
> is unsafe by construction: `sh("rm -rf " + userPath)` is classic injection, and
> a `String` param *invites* exactly that misuse. It is rejected (§4).

## 3. Runtime facts the design depends on (Bun 1.3.14, verified)

- **`.raw` is load-bearing.** `Bun.$` reads the command text from `.raw`, not the
  cooked array. Injecting `.raw` onto a hand-built array makes
  `Bun.$(arr, ...subs)` run with no real template literal. Invariant:
  `strings.length === subs.length + 1`. (Our guest supplies the raw segments
  directly, so `cooked === raw === parts` — the cooked/raw-divergence subtlety of
  real template literals does not arise.)
- **`ShellOutput`** (the awaited value) exposes `stdout` / `stderr` (Node
  `Buffer`, i.e. `Uint8Array`), `exitCode` (number), and `text()` / `json()` /
  `bytes()` / `blob()` / `arrayBuffer()`.
- **A non-zero exit THROWS** a `ShellError` by default (carrying `exitCode` +
  `stdout` + `stderr`). `.nothrow()` returns the `ShellOutput` instead; `.quiet()`
  suppresses mirroring to the terminal (capture is unaffected, and it does *not*
  stop throwing). Per-command builders exist: `.cwd()`, `.env()`, `.nothrow()`,
  `.quiet()`, `.throws()`.
- **`Bun.$.escape(s)`** returns the shell-quoted form of a string — the explicit
  escaper for any literal-command path.
- `ShellPromise` **extends `Promise`** (a subclass with no direct type args), so
  the binding's result rides the existing `@suspending` reactor (same as
  `global::fetch`); `getAwaitedType` already handles the subclass.

## 4. Approaches considered

| | Approach | Verdict |
|---|---|---|
| **A** | **Modify the bindgen** to *generate* a `taggedTemplate` `@extern` for `Bun.$` (host injects `.raw`; carries cooked+raw+exprs) | Rejected as primary — special-cases the generator (dishonest), is `Bun.$`-only, and does the same host work as C. See §6. |
| **B** | A single-string `bun::sh(cmd: String) -> ShellOutput` | **Rejected** — deletes the substitution boundary → shell injection. `bun::spawn(argv)` already covers safe no-shell exec. |
| **C** | A **general host primitive** (`js::tagged`) + a **bun-only `shell.si` stdlib** | **Recommended.** Keeps the generator honest, generalizes to the whole tagged-template family, preserves escaping by construction. |

## 5. The design (Approach C)

### 5.1 Layer 1 — `js::tagged`, a general tagged-template invoker

Add to the **hand-authored** `js` module (`compiler/src/strata/modules/js.si`,
which already owns bespoke runtime ops — `apply`/`construct`/the error channel):

```silicon
\\ @extern tagged (JSValue, JSValue, JSValue) -> JSValue;   # (tag, parts, exprs) -> tag(rawArr, ...exprs)
```

Host shim (`cli/src/host/js-host.ts`, in the `js:` object — `errBox` already in scope):

```ts
tagged: (tag: any, parts: any, exprs: any) => {
    try {
        const s = [...parts]
        Object.defineProperty(s, 'raw', { value: [...parts] })   // .raw is the load-bearing text; non-enumerable like a real TSA
        return tag(s, ...exprs)
    } catch (e) { errBox.last = e; return null }   // failures lift via js::had_error / js::take_error
}
```

- **Synchronous** — returns whatever the tag returns: a `String` handle for
  `String.raw`/`css`, a `ShellPromise` handle for `Bun.$`, a query for `Bun.sql`.
- Each `exprs[i]` crosses as a distinct element → Bun escapes it as one argument.
  **The substitution boundary is preserved by construction.**
- Errors route to the existing boundary-error channel (`ffi.si` `js_try`).

This one primitive binds the entire tagged-template family. It is the keystone.

### 5.2 Layer 2 — `shell.si`, the ergonomic + safe shell layer (bun-only)

`Bun.$` is async and we want `.nothrow().quiet()` baked in, so the shell entry is
a dedicated `@suspending` host extern (it composes invoke + await + config — more
than the sync `js::tagged` does). New `compiler/src/strata/modules/shell.si`:

```silicon
# Run a command: parts = literal segments, subs = (auto-escaped) substitutions.
# Invariant maintained by the helpers: len(parts) == len(subs) + 1.
\\ @suspending @extern run (JSValue, JSValue) -> JSValue;        # (parts, subs) -> awaited ShellOutput
\\ @extern escape (JSString) -> JSString;                        # Bun.$.escape — explicit quoting
```

Host shims:

```ts
shell: {
    run: (parts: any, subs: any) => {
        const s = [...parts]; Object.defineProperty(s, 'raw', { value: [...parts] })
        return Bun.$(s, ...subs).quiet().nothrow()   // ShellPromise → reactor awaits → ShellOutput (never throws)
    },
    escape: (s: any) => Bun.$.escape(s),
}
```

`.nothrow().quiet()` is baked in so a failing command surfaces its `exitCode` as
**data**, not a trap (the right model for a no-exceptions systems language).

**`ShellOutput` readers** — thin Silicon `@fn`s over `js::` (all reading a
`JSValue` handle), in `shell.si`:

```silicon
\\ exit_code (JSValue) -> Int                # js::as_int(js::get(out, "exitCode"))
\\ text (JSValue) -> String                  # js::as_str(js::call(out, "text", js::array())) → toString
\\ stdout_bytes (JSValue, Int, Int) -> Int   # js::bytes_out over out.stdout (raw Uint8Array → linear)
```

**Ergonomic sugar** (Silicon has no variadics, so fixed-arity + a builder):

```silicon
# Builder — accumulate, then run; sh_sub pushes an ESCAPED substitution, sh_seg a literal.
\\ sh_new () -> Int                          # a handle pair { parts: js::array, subs: js::array }
\\ sh_seg (Int, JSString) -> Void            # push a literal segment
\\ sh_sub (Int, JSString) -> Void            # push a substitution (auto-escaped at run)
\\ @async sh_run (Int) -> JSValue            # @await shell::run(parts, subs) -> ShellOutput

# Fixed-arity sugar for the common case `$`<a> ${x} <b>``:
\\ @async sh1 (JSString, JSString, JSString) -> JSValue   # sh1("echo ", x, "") ≡ $`echo ${x}`
```

**Guest usage:**

```silicon
@use 'shell';
# Safe: `dir` is a substitution → escaped, can't inject.
out := @await(sh1("ls ", dir, ""));
n   := shell::exit_code(out);
listing := shell::text(out);
```

The `sh_seg` / `sh_sub` split makes the safety boundary explicit *in the API*: a
literal goes to `sh_seg`, a runtime value goes to `sh_sub`. There is no API path
that concatenates a value into a segment.

> **Honest ergonomics ceiling.** Even `sh1` forces the caller to split literals
> from substitutions positionally (`sh1("echo ", x, "")`, note the trailing
> empty segment for the invariant). A literal `` $`echo ${x}` `` would need
> template-literal sugar in the parser — out of scope (the grammar is frozen;
> `CLAUDE.md`). The split is the price of guaranteed escaping, and it is worth it.

### 5.3 Error model

- Default `shell::run` is `.nothrow()` → inspect `exit_code(out)` and branch. No
  trap on non-zero exit.
- A future `run_strict` (omit `.nothrow()`) lets the thrown `ShellError` lift via
  `ffi.si` `js_try` into a `Result[…, String]` for guests that prefer it.

## 6. Why NOT modify the bindgen (Approach A)

- The dts rejection of `Bun.$` is **correct and tested** — a tagged template
  genuinely cannot be expressed as a normal `@extern`. Generating one would make
  the generator special-case a syntactic form it otherwise (rightly) declines.
- It would do the **same** `.raw`-injection host work as Approach C, but only for
  `Bun.$`, and would still need a name override (`$` is not a valid identifier).
- Approach C reaches `Bun.$` through the hand-authored `js`/`shell` runtime path
  (exactly how `js.si`/`console.si` already provide bespoke capabilities),
  leaving the bindgen surface **honest** and unlocking the whole tag family for
  near-identical cost.

## 7. Platform, gating, capabilities

- **web/bun only.** Everything here is Tier-2 `JSValue` externref; under
  `--platform=native` it must `E0010`-error, exactly like the other Tier-2
  modules. `shell.si` is hand-authored (not generated) and ships behind the bun
  platform gate; a web-env host simply doesn't supply the `shell` import.
- **Ambient authority.** Arbitrary shell execution is a privileged sink. It is a
  natural candidate for a future **capability tag** (ADR 0011/0012) — `shell::run`
  would require a `Shell` capability the entry point mints — so a library can't
  silently shell out. Noted as a follow-up, not a blocker.
- Per ADR-0023's decision rule, this adds **no type-system abstraction**, so it
  doesn't touch the identity forks; the only judgment call is the security stance,
  settled above.

## 8. Phasing & scope

1. **Phase 1 — `js::tagged`** (the keystone). One host shim + one `js.si` line +
   a test. Smallest unit; unlocks `String.raw`/`css`/`gql` and returns the
   `Bun.$`/`Bun.sql` promise handles.
2. **Phase 2 — `shell.si`** (the ergonomic safe shell). `shell::run`
   (`@suspending`), the `ShellOutput` readers, `sh_*` sugar, `shell::escape`, the
   `E0010` native gate, and tests.
3. **Phase 3 (optional)** — capability-tagging; a curated example; `Bun.sql` via
   the same primitive; a `run_strict` `Result` variant.

## 9. Test plan

- **`js::tagged` (deterministic, sync):** drive `String.raw` —
  `js::tagged(js::global("String") ▷ raw, ["a\\nb"], [])` returns the raw text —
  proving the `.raw` injection and the invariant, with no async/process surface.
- **Escaping (the security test):** `sh1("echo ", "a; touch /tmp/PWNED", "")` →
  assert stdout is the literal string **and** `/tmp/PWNED` was *not* created —
  proving substitutions are escaped across the FFI.
- **Result surface:** `exit_code` for a `exit 3` command (no trap, `.nothrow()`),
  `text` for `echo hi`.
- **Native rejection:** compiling a `shell::run` program with `--platform=native`
  errors `E0010`.

## 10. Open questions

- **`js::tagged` async ergonomics.** For async tags reached *directly* via
  `js::tagged` (not `shell::run`), the guest gets a promise handle to await via
  the `promise::`/`future_async` bridge. `shell::run` sidesteps this by being
  `@suspending`. If `Bun.sql` is added, give it its own `@suspending` entry too.
- **Builder representation.** `sh_new` returns a handle pair; whether that's a
  `js::object { parts, subs }` or a small Silicon record is an implementation
  detail (the `js::object` form needs no new machinery).
- **Capability tagging** timing — ship behind the bun gate now, add the `Shell`
  capability when ADR 0011/0012 land.
