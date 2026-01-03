# Elaboration in Silicon

User-Defined Language Constructs Without Macros

Silicon is designed to be extensible without becoming fragile.

Instead of traditional macros or compiler plugins, Silicon grows through a mechanism called elaboration. Elaboration allows both built-in and user-defined language constructs to be translated into a small, stable core language in a structured, deterministic way.

This document explains:

What elaboration is

How Silicon’s compiler architecture supports it

Why this design was chosen over macros or grammar extension

How definitions and expressions participate uniformly

How this enables safe, library-defined language growth

Motivation

Many languages that support “language extension” do so via macros. While powerful, macros often come with significant downsides:

Textual rewriting or AST surgery

Poor error messages and source mapping

Tooling complexity (IDEs, formatters, linters)

Non-deterministic builds

Hygiene and scoping footguns

A split between “real language features” and “macros”

Silicon aims to provide the expressive power of macro systems while avoiding their traditional costs.

The core idea is simple:

Silicon programs are elaborated into a small, stable core language.
Language constructs—built-in or user-defined—participate in elaboration uniformly.

Fixed Grammar, Flexible Semantics

Silicon intentionally keeps its grammar small and stable.

Instead of many syntactic forms, the language uses:

A single grammatical structure for all definitions

A single grammatical structure for all infix expressions

Parsing answers only:

“Is this structurally valid?”

Meaning and intent are determined later.

This design shifts complexity from parsing to semantic elaboration, which is where extensibility lives.

Elaboration: The Core Concept

Elaboration is the compiler phase that translates parsed surface syntax into a small set of core declarations and core expressions.

Elaboration is:

Deterministic

Phase-structured

Source-mapped

Tooling-friendly

Fully type-checked after expansion

Elaboration is not:

Textual substitution

Reader macros

Arbitrary AST mutation

Runtime metaprogramming

Def-Kinds and Elaboration Hooks

Every definition in Silicon begins with a keyword, such as:

@fn
@var
@type


These keywords identify the definition kind, or Def-Kind.

Def-Kinds

A Def-Kind determines how a definition is elaborated.

Examples:

@fn → function definition

@var → global value

@type → type declaration

@extern, @test, @route, etc.

Crucially:

Built-in Def-Kinds are implemented using the same mechanism as user-defined ones.

There are no “magic” keywords in the compiler.

Elaboration Hooks

Each Def-Kind is implemented by an Elaboration Hook.

An elaboration hook:

Receives the parsed definition (the def shell)

Validates its structural schema

Produces one or more core declarations, or

Produces additional surface definitions that will themselves be elaborated

Elaboration hooks are registered in a Def-Kind registry keyed by keyword.

This registry is populated by:

Built-in language definitions

Imported libraries

Third-party addons

Schema-Driven Validation

Each Def-Kind declares a schema describing what is allowed:

Are parameters allowed or required?

Is an assignment required?

Is a type annotation permitted?

Is a body required?

Schema validation occurs before elaboration logic runs.

This ensures:

Consistent error messages

Predictable behavior

Simpler handler implementations

Better tooling support

Expression Elaboration (Expr-Kinds)

Silicon applies the same philosophy to expressions.

Surface expressions are structurally simple:

Function calls

Binary infix expressions

All infix expressions share a single grammar rule.
Meaning is determined by the operator token.

Each operator corresponds to an Expr-Kind, elaborated via a handler.

Examples:

a + b → elaborated into a function call

a && b → elaborated into conditional control flow

User-defined operators can elaborate similarly

This keeps expression parsing uniform while allowing semantic extension.

The Core Language

Elaboration lowers all constructs into a small, stable core language.

Core Declarations

The compiler recognizes only a few core declaration kinds, such as:

Functions

Globals

Type declarations

External declarations

Exports

Module initialization (optional)

Every Def-Kind—built-in or user-defined—ultimately produces only these.

Core Expressions

Similarly, the core expression language is intentionally minimal:

Variable references

Literals

Function calls

Let / block expressions

Conditionals

More complex constructs (loops, short-circuiting operators, pattern matching, etc.) are elaborated into these primitives.

This keeps:

Typechecking simple

Optimization tractable

WASM lowering straightforward

The compiler architecture stable

Compiler Architecture Overview

A typical Silicon compilation pipeline looks like:

Parse

Build surface AST using a fixed grammar

Register Def-Kinds

Load built-ins

Load imported addons

Elaboration

Validate schemas

Invoke elaboration hooks

Produce core declarations

Name Resolution & Typechecking

Operate only on core language

Lowering

Translate core IR to WASM (or other targets)

At no point does the compiler need to distinguish “language feature” from “library extension”.

Determinism and Safety

Elaboration hooks execute at compile time and are subject to constraints:

Deterministic by default

No implicit access to IO, time, randomness, or environment

Optional capability-based opt-ins for controlled effects

Bounded expansion depth and size

Mandatory source mapping for diagnostics

This ensures:

Reproducible builds

Cacheable compilation

Clear error reporting

Resistance to supply-chain attacks

Why Not Macros?

Silicon deliberately avoids the term macro.

Unlike traditional macros, elaboration hooks:

Do not rewrite syntax

Do not modify parsing

Do not bypass typechecking

Do not introduce unstructured AST transformations

Instead, elaboration is a semantic lowering phase, similar to those found in ML-family languages and modern compilers.

Design Philosophy

This approach reflects several core principles:

Small core, rich surface

Libraries can grow the language

Tooling must remain reliable

The compiler should be teachable

Language evolution should be additive

Silicon is not extended by syntax tricks.
It grows by elaboration.

Summary

Silicon uses Elaboration Hooks instead of macros

Definitions are categorized by Def-Kinds

Expressions are categorized by Expr-Kinds

Built-ins and user extensions are treated uniformly

All constructs elaborate into a small, stable core language

The grammar remains fixed and tooling-friendly

Language growth becomes a library concern, not a compiler rewrite

This design enables Silicon to be:

Expressive

Extensible

Safe

Predictable

Long-lived