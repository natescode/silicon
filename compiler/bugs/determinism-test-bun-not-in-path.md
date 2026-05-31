# Bug: determinism property test fails — `bun` not in PATH for subprocess

**Test:** `determinism > cross-process: two fresh bun runs produce identical WAT`  
**File:** `tests/properties/determinism.property.test.ts:106`  
**Status:** Failing  
**Severity:** Environment / CI config — not a compiler bug

## Symptom

```
error: Executable not found in $PATH: "bun"
  at runOnce (tests/properties/determinism.property.test.ts:107:27)
```

## Root cause

The test spawns two child processes with `Bun.spawnSync(['bun', 'run', ...])` to
check that two independent compilations of the same source produce identical WAT
output (guards against non-determinism from filesystem iteration order, module
cache seeding, global state, etc.).

`bun` is installed at `~/.bun/bin/bun` but that path is not on `$PATH` in the
environment that the test runner inherits when launching subprocesses. The parent
process resolves `bun` correctly (it was invoked as `~/.bun/bin/bun test ...`),
but `Bun.spawnSync` uses the inherited `$PATH` which doesn't include
`~/.bun/bin/`.

## Reproduction

```bash
# Works:
~/.bun/bin/bun test tests/properties/determinism.property.test.ts

# Fails with "Executable not found":
PATH=/usr/bin:/bin ~/.bun/bin/bun test tests/properties/determinism.property.test.ts
```

## Fix direction

Two options:

**Option A — Resolve the bun executable path at spawn time (preferred):**

```ts
import { execSync } from 'child_process'
const bunPath = process.execPath  // Bun sets this to the current bun binary
// or: execSync('which bun').toString().trim()

const r = Bun.spawnSync([bunPath, 'run', compileScript, sampleFile], { ... })
```

`process.execPath` is the path to the currently-running `bun` binary, so it
works regardless of PATH.

**Option B — Add `~/.bun/bin` to PATH in CI / shell profile:**

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

This is a one-line fix in `.bashrc` / `.zshrc` or the CI environment config,
but Option A is more robust since it doesn't depend on shell setup.
