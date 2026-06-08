# modules_demo — ADR-0024 module/component system

A small component showing the three tiers (component ⊃ module ⊃ file):

```
modules_demo/
  sgl.toml              the COMPONENT root
  src/main.si           ROOT module — holds `main`/`run`
  src/util.si           ROOT module (sibling, auto-included, shares scope)
  src/math/ops.si       module `math`  — @pub square/add, private mul
  src/math/helpers.si   module `math`  (sibling file, calls private `mul`)
  src/text/text.si      module `text`  — @pub score, calls `math::`
```

Key points it demonstrates:

- **Directory = module.** `src/math/` is module `math`; call its public members
  as `math::square(4)`. Files in `src/` are the ROOT module, called unqualified
  (`banner(...)`).
- **Auto-inclusion.** `math/ops.si` and `math/helpers.si` share one scope —
  `cube` calls the private `mul` with no `@use` and no qualifier.
- **`@pub` visibility.** `mul` is module-private: `math::square`/`math::cube`
  work across modules, but `math::mul` from another module would be `E-PRIV`.
- **Cross-module DAG.** `text` depends on `math` (`text -> math`); a cycle would
  be `E-MOD-CYCLE`.

Build / run:

```sh
cd examples/modules_demo
sgl check          # typecheck the whole component
sgl build --wat    # one core .wasm — every module statically merged in
sgl run            # compute run() (= 34)
```

No `@use` lines anywhere — the module system replaces intra-component includes
(ADR-0024).
