# Bootstrapping

This obviously relates to Silicon and Sigil. To bootstrap Sigil, this is the plan.

## Stage 0

The first compiler will be written in Ohm.js. This will have the prelude elaborations (spells) built-in to the compiler implementation. This stage does not have a linker as it won't be needed. 


### Stage 0.1

Expose just enough WASI(X) APIs to make the compiler work.

## Stage 1

The compiler will be re-written in Silicon. The prelude will then be define via elaboration hooks. The 