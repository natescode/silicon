## Strata Implementation

There are three requirements

- [x] Grammar
- [ ] Elaboration Hook
- [ ] Intrinics


Elaboration looks up *Keyword* or *Operator* to attach the [Semantics](#)

Semantics are nodes, basically a function that tells the compiler what to do.

Elaboration hooks can define

- StrataType::Constraint
- StrataType::Type
- StrataType::Capability
- StrataType::Operator
- StrataType::Control
- StrataType::Runtime
- StrataType::Codegen
- StrataType::Metadata
- StrataType::DSL


## Boostrap Story

Silicon Core features

- Parse whole grammar
- No operators
- Keywords
    - @stratum
- instrinsics

```silicon
@stratum Plus (Operator, "+", Node) = {
    &wasm::i32_load (&wasm::i32_const Node.left);
    &wasm::i32_load (&wasm::i32_const Node.right);
    &wasm::i32_load;
}; 
```


That will then allow 

```1 + 2;``

to be complied correctly.

Later, when Strata support the type system, then I can constrain that the left and right parameters are the same type.