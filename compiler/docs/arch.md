# Arch 

Source Files
   │
   ▼
┌───────────────┐
│  Parse (Ohm)  │
│  CST output   │
└───────┬───────┘
        │
        ▼
┌──────────────────────┐
│ CST → Core AST       │
│ basic syntax nodes   │
│ no deep meaning yet  │
└─────────┬────────────┘
          │
          ▼
┌──────────────────────────────┐
│ Strata Registration / Index  │
│                              │
│ - collect defined Strata     │
│ - load imported Strata       │
│ - build lookup environment   │
│ - validate Strata metadata   │
└─────────┬────────────────────┘
          │
          ▼
┌──────────────────────────────┐
│ Elaboration                  │
│                              │
│ - resolve names              │
│ - resolve native keywords    │
│ - resolve operators          │
│ - consult Strata hooks       │
│ - attach semantic meaning    │
│ - lower sugar to core forms  │
│ - enforce Strata constraints │
└─────────┬────────────────────┘
          │
          ▼
┌──────────────────────────────┐
│ Typed / Elaborated IR        │
│                              │
│ - capabilities known         │
│ - protocol info attached     │
│ - Strata effects recorded    │
│ - core semantics stabilized  │
└─────────┬────────────────────┘
          │
          ▼
┌──────────────────────────────┐
│ Analysis / Optimization      │
│                              │
│ - type checking / inference  │
│ - borrow / mut rules         │
│ - capability checks          │
│ - partial evaluation         │
│ - Strata-driven rewrites     │
└─────────┬────────────────────┘
          │
          ▼
┌──────────────────────────────┐
│ WASM Lowering                │
│                              │
│ - map IR to WASM model       │
│ - memories / locals / calls  │
│ - effect lowering strategy   │
└─────────┬────────────────────┘
          │
          ▼
┌──────────────────────────────┐
│ WAT / WASM Emission          │
└──────────────────────────────┘