# Third-Party Notices — Silicon Playground

The static playground bundle (`dist/index.html`) contains **no third-party
runtime code** — it is entirely first-party (the Silicon compiler, including
its hand-written parser; ohm-js was removed when the hand-written parser became
the default).

- The compiler assembles WebAssembly with its own direct binary emitter
  (including funcref/call_indirect), so the bundle does **not** include `wabt`
  or `binaryen` (both Apache-2.0). `wabt` is marked external and only
  lazy-loaded by the Node-side `watToWasm` helper, which the browser never
  calls; `binaryen` is blocked by the build's dependency tripwire.
- **CodeMirror** (the editor) is loaded at runtime from a CDN — not bundled —
  and is MIT-licensed.

There are therefore no bundled third-party licenses to reproduce here.
