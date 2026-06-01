# Announcing Silicon Alpha 1.0: A Hackable Language for the Rest of Us

After years of designing, scrapping, redesigning, and quietly obsessing over compiler internals at odd hours of the night, I'm thrilled to announce the first public alpha of **Silicon** — a small, extensible programming language built on a hackable compiler.

This post is going to be long. Grab a coffee. I want to tell you not just what Silicon *is*, but why it exists, how it got here, and what makes it genuinely different from the dozens of hobby languages you've seen announced on Hacker News and promptly forgotten about. I'll try to be honest about where it's rough around the edges, because Alpha 1.0 is not a finished product — it's an invitation.

---

## The Origin Story: Why Build a Language at All?

Every programming language starts with frustration. Silicon is no different.

I've been writing software as a serious hobby for years, bouncing between languages the way some people bounce between frameworks. Go for its blissful simplicity. JavaScript for its ubiquity and flexibility. Lisp for the way it makes you feel like you're touching something fundamental about computation. Each one scratched a different itch, but none of them scratched *all* the itches at once. When I sat down to write a side project, the choice of language was always a compromise.

Go is simple and fast, but its extensibility story is basically nonexistent. You write Go the way the Go team wants you to write Go. JavaScript is everywhere and flexible, but the runtime overhead, the ecosystem chaos, and the perpetual feeling that the language is held together with duct tape and backwards compatibility promises gets exhausting. Lisp is elegant and extensible to its core, but it carries decades of cultural baggage and a syntax that — no matter how much you intellectually appreciate it — makes it hard to onboard anyone else.

What I wanted was something that felt like all three of them at once: the simplicity and directness of Go, the multi-target flexibility of JavaScript, and the deep extensibility of Lisp. Something small enough that I could hold the whole thing in my head. Something I could shape to fit whatever I was building rather than shaping my project to fit the language.

So I started designing Silicon.

That was years ago. What you're seeing today with Alpha 1.0 is the culmination of a lot of design iterations, a lot of thrown-away prototypes, and a lot of late-night reading of programming language theory papers that I only half understood but found completely captivating. The result is a language that I'm genuinely excited about — not because it's perfect, but because it's *mine* in a way that nothing else could be, and because the core ideas behind it are, I think, genuinely interesting.

---

## What Silicon Is (and Isn't)

Silicon is a **small, extensible language built on a hackable compiler**.

Every word in that sentence matters, so let me unpack it.

**Small** means that the language itself has a minimal core. There is no sprawling standard library, no battery of built-in abstractions, no opinionated runtime fighting you for control. The surface area of the language is intentionally limited. This is a feature, not a bug. A small language is a language you can actually learn in full, reason about completely, and extend confidently.

I mean *minimal* in a more radical sense than most languages that use that word. Silicon's core — the language as it exists before any compiler interaction — is not Turing complete. Let that sink in for a moment. Out of the box, with no extensions, Silicon cannot express arbitrary computation. It is a substrate, not a finished tool. This is entirely intentional.

The reasoning goes like this: if you want a language that is truly small and truly stable, you have to decide what the core actually *is*. Most languages creep. They start small and accumulate features year over year until the "core" is enormous and nobody agrees on what belongs there anymore. Silicon avoids this by drawing a hard line. The core is not Turing complete. Everything beyond that line — loops, recursion patterns, control flow abstractions, domain-specific constructs — is provided by the compiler through Strata. The core stays frozen. The capabilities grow.

**Extensible** means that Silicon is designed to grow — but to grow *from within itself*, not by waiting for me to add features. This is where Silicon departs most radically from the languages that inspired it, and we'll get deep into this when we talk about Strata.

**Hackable compiler** means the compiler — named **Sigil** — is not a black box. Sigil exposes APIs that Silicon code itself can call. The boundary between "language user" and "language implementer" is deliberately blurred. And because the core language is intentionally incomplete, Sigil isn't optional infrastructure — it's the thing that makes Silicon usable at all. The compiler bootstraps the language into existence at every build. That's not a limitation; it's the architecture.

What Silicon is **not**: a production-ready language with a polished ecosystem, a corporate-backed project with a roadmap committee, or a language trying to replace anything. It is a serious hobby project. I use "serious" deliberately — this isn't a weekend toy. The design decisions are intentional, grounded in research, and motivated by real problems I've run into writing real software. But it is a hobby, which means I've had the freedom to make interesting choices instead of safe ones.

---

## The Language: A Blend of Lisp, Go, and JavaScript

Silicon's syntax and semantics sit at the intersection of its three main inspirations.

From **Go**, Silicon borrows its philosophy of radical simplicity. Go famously omits features that most languages include as a matter of course — inheritance, operator overloading, generics (for a long time), exceptions. Silicon takes a similar posture: if a feature can be composed from simpler primitives, it probably shouldn't be in the core language. The result is code that reads straightforwardly and doesn't hide complexity behind syntactic sugar that might surprise you.

From **JavaScript**, Silicon takes its pragmatic multi-target flexibility. JavaScript runs everywhere — browser, server, edge, embedded — and while that ubiquity comes with costs, the core idea is compelling. Silicon is designed from the ground up to target multiple execution environments, and the language's semantics are defined in a way that makes this natural rather than awkward. More on platform targeting below.

From **Lisp**, Silicon inherits its deepest and most distinctive trait: the idea that a language should be able to describe and transform itself. Lisp's macro system is one of the great ideas in programming language history. Silicon doesn't clone it directly, but it draws on the same philosophical root — that the distinction between data and code is artificial, and that a sufficiently powerful language should be able to eat its own source.

In practice, Silicon code reads like a cleaned-up JavaScript with Go's explicitness and some parenthetical Lisp influence in how expressions compose. It's not jarring if you've worked in any of those languages, but it's not quite any of them either. It's its own thing.

---

## Strata and Sigil: The Feature That Makes Silicon Interesting

If you only remember one thing about Silicon, make it this: **Strata**.

A Stratum (plural: Strata) is the mechanism by which Silicon extends itself from within the language. Through Sigil's Compiler API, Silicon code can reach into the compilation pipeline, inspect and manipulate the abstract syntax tree, and add new language constructs — all written in Silicon itself.

Remember that Silicon's core is not Turing complete. Strata is how that changes. When Sigil compiles your program, it runs your Strata first. Those Strata can add control flow, define new constructs, perform compile-time computation, and generate arbitrary Silicon code — turning the intentionally minimal core into something expressive enough to write real programs. You're not working around a limitation. You're using the mechanism the language was designed around.

Think about what this means. In most languages, when you want a new feature, you have two options: write a proposal to the language committee and wait years, or use a preprocessor/macro system that operates on text and loses all semantic information. Neither option is great. Language committees move slowly and prioritize stability over expressiveness. Text-based macros are powerful but dangerous — they operate at the wrong level of abstraction and tend to produce error messages from hell.

Strata operates at the right level. It hooks into Sigil after parsing, where the code is already a well-formed tree of semantic nodes. A Stratum can inspect types, follow symbol references, understand scope, and generate new valid Silicon code — and it does all of this using the same Silicon you'd write anywhere else. There's no separate macro language to learn, no preprocessor DSL, no C template metaprogramming nightmare. It's just Silicon, talking to Sigil, written by you.

The implications are significant. Consider some things that are typically hardcoded into a language:

- **New syntax for common patterns**: If you're building a web framework and you want a `route` keyword that compiles down to handler registration, you can write a Stratum that makes that work. You're not stuck with function calls if a keyword would be clearer.
- **Domain-specific optimizations**: A Stratum can inspect code patterns and rewrite them to more efficient forms at compile time, with full knowledge of types.
- **Embedded DSLs**: You can define a sub-language within Silicon that compiles via a Stratum. Write a SQL-like DSL that's type-checked against your schema, right in your Silicon source file.
- **Compile-time validation**: Add invariants that go beyond what the type system can express natively, and get clear, accurate error messages when they're violated.

This is not just pattern matching on syntax. Because the Compiler API exposes semantic information, a Stratum knows what a symbol resolves to, what type an expression has, and what the surrounding context means. It can make intelligent, informed transformations.

### Sigil as a DSL Engine

Here's the implication that took me a while to fully appreciate: because Sigil is a hackable compiler with a well-defined API, it doesn't have to only serve Silicon.

Sigil can be used to build entirely new domain-specific languages from scratch. The same infrastructure that lets a Silicon Stratum rewrite an AST node can be pointed at a completely foreign grammar. You define your language's parse tree, write transformations against Sigil's API, and emit whatever target you like — native, Node, browser, WASI. Silicon becomes the implementation language for your compiler, and Sigil becomes the engine underneath it.

This means a team building a configuration language, a query language, a shader language, or a data pipeline DSL doesn't have to write a compiler from scratch. They write a Stratum (or a collection of them) that teaches Sigil their language. They get Sigil's type system, target backends, toolchain integration, and error attribution infrastructure for free. The DSL author focuses on their domain; Sigil handles the rest.

This is the long game I'm most excited about for Silicon. Not just a language you use, but a compiler platform you build on.

This is the feature I'm most excited about in Silicon. It's the feature I've spent the most time on, the one that's gone through the most redesigns, and the one that I think gives Silicon a genuine identity in the language space. Languages are either small and rigid, or large and sprawling. Strata is my answer to that false dichotomy: stay small in the core, and give users the power to grow the language themselves.

---

## An Eternal Grammar: Designing for the Next Fifty Years

Most languages are designed to be convenient. Silicon's grammar was designed to be *permanent*.

This is one of Silicon's most ambitious promises, and I want to be upfront: it's a *goal*, not yet a guarantee. Alpha is too early for that. But by the time Silicon reaches beta, I intend to make this commitment explicit and binding: **Silicon code written today should parse correctly fifty years from now.** Silicon 2026 should be readable by a Silicon 2076 compiler without modification.

That's an unusual thing to promise. Most languages don't even try. Python 2 to Python 3 broke the world. JavaScript's evolution is an ongoing negotiation between backwards compatibility and sanity. C++ has been accumulating syntax for decades and the grammar is now so complex that parsing it is theoretically undecidable without full semantic analysis. These aren't criticisms — language design under real-world constraints is genuinely hard — but they illustrate what happens when longevity isn't a first-class design goal.

For Silicon, longevity was the goal. Every grammatical decision was made with the question: *will this still parse unambiguously in fifty years?*

### LL(1): The Grammar That Never Bites

Silicon's grammar is **LL(1)** — parseable with a single token of lookahead, top-down, left-to-right. This is one of the most restrictive grammatical classes you can choose, and I chose it deliberately.

An LL(1) grammar has a remarkable property: it is completely unambiguous. At every point in parsing, there is exactly one valid thing that can come next, determinable by looking at exactly one token. There's no backtracking, no speculative parsing, no disambiguation rules applied after the fact. The grammar either accepts your program or it doesn't, and it tells you immediately and precisely where it rejected it.

This makes Silicon easy to parse. Not just easy for Sigil to parse — easy for *any* parser, in any language, written by anyone, now or in the future. An LL(1) grammar is so well-understood that undergraduates implement parsers for them in compiler courses. If you want to write a Silicon parser in a language I've never heard of, for a platform that doesn't exist yet, the grammar won't fight you.

### No Operator Precedence. No Prefix or Postfix Operators. One Symbol, One Meaning.

These three rules are where Silicon's grammar gets visually strange, and where I get the most raised eyebrows.

**No operator precedence.** In most languages, `1 + 2 * 3` evaluates to `7` because multiplication has higher precedence than addition. You learn the precedence table, you internalize it, you occasionally get it wrong and introduce a bug. Silicon has no precedence table. Expressions are explicit about grouping. This looks different on the page, but it means the grammar is unambiguous without any precedence resolution step, and it means you will never write a Silicon expression that evaluates differently than you intended because you forgot where `&` falls relative to `==`.

**No prefix or postfix operators.** Prefix operators (`!x`, `-x`, `++i`) and postfix operators (`i++`, `obj?.method()`) create grammatical ambiguity and parsing complexity that is disproportionate to their convenience. Silicon's grammar doesn't include them. Operations that look like prefix or postfix operators in other languages are expressed differently in Silicon. This is visually unfamiliar, but it eliminates an entire class of parsing edge cases — edge cases that have historically caused bugs in parsers, linters, formatters, and language tooling for decades.

**Each symbol has exactly one meaning.** In many languages, the same character means different things depending on context. `*` is multiplication, pointer dereference, and wildcard import. `&` is bitwise AND, address-of, and reference qualifier. `<` is less-than, generic open bracket, and sometimes part of a shift operator. The parser needs context — sometimes full semantic context — to know which meaning applies.

In Silicon, each symbol has one meaning. Always. In every context. If you see a particular symbol in Silicon code, you know exactly what it does without reading the surrounding context. This is a significant constraint on the syntax designer (me), and it leads to some choices that look odd if you're coming from C-family languages. But it means the grammar is context-free in the formal sense, that parsing requires no semantic information, and that a Silicon parser written today will still parse Silicon code correctly in 2076 even if the semantics of the language have evolved.

### Why This Matters

The eternal grammar promise is about more than syntax stability. It's about the entire ecosystem of tooling that grows up around a language.

Consider what happens when a language's syntax changes. Formatters break. Linters break. Syntax highlighters break. AST-based refactoring tools break. Documentation generators break. Every tool that touches source text has to be updated. The Silicon ecosystem — every editor plugin, every formatter, every static analyzer, every Stratum that someone writes — is built on the grammar. If the grammar is stable forever, those tools are stable forever.

It also means that Silicon source code is a durable artifact. If you write Silicon today and come back to it in twenty years, you don't need to run a migration script. You don't need to remember which version introduced the breaking change. You open the file, it parses, and you continue.

The grammar may look unusual. Some of the choices that make it LL(1) and operator-free are genuinely unfamiliar if you've spent years in languages that make different tradeoffs. But every decision was intentional, every constraint was considered, and every piece of visual weirdness is load-bearing. The grammar wasn't designed to look like languages you already know. It was designed to still work in fifty years.

---

## Platform Targeting: Write Once, Run Everywhere (For Real This Time)

Silicon is designed to target multiple execution environments, and the language surfaces this as a first-class concept rather than an afterthought.

Currently, Silicon can target:

- **Native** — Compiles to native code. When targeting native, Silicon code has access to the C standard library, which is an elegant solution to the "no standard library" problem. Rather than reinventing `malloc`, file I/O, and string operations, Silicon simply exposes what C already provides. The C library is the de facto standard library of the native computing world, and leaning on it keeps Silicon's core small without leaving you stranded.

- **Node.js** — When targeting Node, Silicon code can use Node's built-in APIs. This opens up the entire Node ecosystem — file system access, networking, process management, streams — without Silicon needing to implement any of it natively.

- **Browser** — Targeting the browser gives Silicon access to Web APIs: the DOM, Fetch, Web Workers, Canvas, and so on. This means you can write Silicon for the frontend without giving up access to the platform.

- **WASI** — The WebAssembly System Interface target lets Silicon compile to portable WebAssembly modules that can run in any WASI-compatible runtime. This is the most portable target, and increasingly relevant as WASI matures into a serious deployment target for server-side and edge computing.

What makes this interesting from a language design perspective is how it interacts with Silicon's minimal core. Because Silicon doesn't have a built-in standard library, there's no "which standard library implementation do I use on this platform" problem. Instead, you import platform-specific APIs directly, and the compiler knows which platform you're targeting. If you try to use a Node API when compiling for the browser, the compiler tells you. The platform target is part of the build, not a runtime surprise.

This was always one of the goals. I wanted a language that could follow me wherever I was working — a CLI tool here, a browser script there, a portable WASM module for something else entirely — without me having to maintain separate codebases in separate languages. Silicon can live in all of those places.

---

## Gradual Memory Management: Inspired by Research

One of Silicon's most technically distinctive features is its approach to memory management, which is inspired by Jonathan Goodwin's work on Gradual Memory Management.

The premise of gradual memory management is that the choice of *how* memory is managed shouldn't be a binary all-or-nothing decision made at the language level. Different programs — and different parts of the same program — have different memory management needs. A hot loop processing game physics wants arena allocation. A long-lived server handling many small requests might prefer reference counting. A module compiled for the browser can delegate to the WASM GC.

Silicon lets you choose. The supported memory management strategies are:

- **WASM GC** — Delegate memory management to the WebAssembly garbage collector. This is the lowest-effort option when targeting WASM-compatible platforms, and it's the right default for many use cases.
- **malloc** — The classic C-style manual allocation. Full control, full responsibility. When you're targeting native and you know what you're doing, this is available.
- **Arenas** — Allocate from a region and free the whole thing at once. Great for workloads with clear lifetime boundaries — parsers, request handlers, game frames. Arena allocation is fast and avoids fragmentation almost entirely.
- **Reference Counting (RC)** — Automatic memory management without a garbage collector, using deterministic reference counting. Predictable performance characteristics, no stop-the-world pauses.

The ability to mix strategies — or to make the choice per-module or per-context — is what makes this "gradual." You're not locked into one memory model for your entire program. This is particularly powerful in combination with platform targeting: you might use the WASM GC when targeting the browser, arena allocation for a hot path in a native build, and RC for everything else.

I've been fascinated by this design space since I first read Goodwin's paper. Memory management is one of the areas where programming languages have historically forced you to choose a tribe — GC tribe or manual-memory tribe — and Silicon's take is that both tribes are sometimes right. The goal is to give you the tools to make the right call for your specific context.

---

## The Toolchain: Alpha 1.0 Ships More Than a Compiler

One thing I wanted to avoid with Silicon was the "here's a compiler, good luck" launch that characterizes a lot of hobby language announcements. A language is not just a spec and a compiler. It's an environment. So alongside the compiler, Alpha 1.0 ships a full (if early) toolchain:

### The CLI

The Silicon CLI is your entry point to everything. Compile files, run projects, manage build targets, and invoke the playground — all through a consistent command-line interface. The CLI is designed to feel familiar if you've used `go` or `cargo`, with a subcommand structure that's predictable and discoverable.

```
silicon build --target native
silicon run main.si
silicon playground
```

The CLI is the thing you'll be using most, and it's designed to get out of your way.

### Sigil, the Compiler

Sigil is where most of the work has happened over the years. It handles lexing, parsing, type checking, Strata execution, and code generation for all four platform targets. The Compiler API that powers Strata is exposed as a proper, documented interface — not a bag of internal functions you're not supposed to touch.

Because Sigil is responsible for bootstrapping Silicon's non-Turing-complete core into something useful, it runs at the center of every build. Your Strata execute inside Sigil, with full access to the AST and type information for your program. Sigil orchestrates the whole pipeline: parse, run Strata, type-check the transformed output, emit target code. The boundary between "compiler" and "language runtime" is, by design, fuzzy.

Sigil's error messages are something I've invested real effort in. Bad error messages are one of the great unsolved UX problems in programming language design, and while Silicon is far from perfect here, I've tried to make errors point you to the right place with the right amount of context. Strata errors in particular get special treatment, because a bad Stratum can produce confusing output, and Sigil works to attribute those errors back to the Stratum code that generated them rather than the code the Stratum produced.

### The Playground

The playground is a local, browser-based interactive environment for Silicon. You can write Silicon code, execute it in the browser context, and see output immediately — no build step, no CLI invocation. It's great for experimentation, for learning the language, and for testing Strata before integrating them into a larger project.

The playground runs Silicon in the browser target by default, which means you have access to Web APIs right there in the interactive environment. It's one of the more fun parts of the toolchain to use.

### The LSP

Silicon has a basic Language Server Protocol implementation, which means editor integration is possible right now. The LSP provides:

- Syntax highlighting
- Basic diagnostics (type errors, unknown symbols)
- Go-to-definition (for functions and variables)
- Hover information

"Basic" is the honest word here. The LSP is not yet as smart as a mature language server like rust-analyzer or gopls. But it's functional, and it makes writing Silicon in a modern editor a significantly better experience than editing in the dark.

### The VSCode Extension

The VSCode extension wires up the LSP and adds Silicon-specific language support for Visual Studio Code. Installation is straightforward, and once it's running you get syntax highlighting, inline errors, and basic navigation out of the box. This is the most polished editor integration available right now and the one I'd recommend starting with.

### The JetBrains Extension (In Progress)

IntelliJ and the JetBrains family of IDEs are a significant chunk of the developer market, and Silicon should work well there too. The JetBrains plugin is in active development and not yet ready for Alpha 1.0, but it's coming. If you're a JetBrains user, watch this space.

---

## What Alpha 1.0 Actually Means

I want to be clear about what "Alpha 1.0" means for Silicon, because I think honesty here matters.

It means the core language is working and the core features are implemented. You can write Silicon programs, compile them to multiple targets, use Strata to extend the language, choose your memory management strategy, and do all of this with a real toolchain. The language is real. The compiler is real. The tools work.

It does not mean Silicon is production-ready, fully documented, or free of rough edges. There is no standard library yet — you'll be leaning on C, Node, browser, or WASI APIs for anything platform-specific, and the ergonomics of doing that will improve. Error messages are better than they were but worse than they should be. The LSP is basic. There are certainly bugs I haven't found yet. The language semantics in a few areas are still evolving.

Alpha 1.0 is the beginning of public development, not the end of private development. I'm opening Silicon up because I've reached a point where the core ideas are solid enough that I want feedback, collaborators, and curious people kicking the tires. I can't make Silicon better in a vacuum.

---

## The Road Ahead

Here's what I'm thinking about for the near future:

**Standard library foundation** — Even a small one. Utilities for strings, collections, file I/O abstracted across platforms. Right now you're assembling everything from platform APIs, which is fine for a power user but a real barrier for getting started.

**Improved LSP** — Completions, smarter diagnostics, better Strata introspection. The LSP should eventually know about Strata-defined extensions, which is a hard problem but an important one.

**JetBrains plugin** — Bringing Silicon to IntelliJ, CLion, and friends.

**More Strata examples and documentation** — Strata is the most powerful and least documented part of Silicon right now. I want to change that with worked examples, a cookbook, and formal documentation of the Compiler API.

**Grammar stability commitment** — The eternal grammar is a goal for beta. That means formally committing to never making a breaking grammatical change, writing a normative grammar document, and publishing a conformance test suite so that third-party parsers can verify they're correct. This is the moment the longevity promise stops being aspirational and starts being contractual.

**Language specification** — A proper spec that's separate from the implementation, so the language definition isn't just "whatever Sigil does."

**Community** — I want Silicon to have a place for people to share Strata, ask questions, and show off what they've built. The form of that community is TBD.

---

## Try Silicon

If you've made it this far, thank you. Writing a programming language is one of the stranger hobbies a person can have, and doing it alone over years means you develop a very specific relationship with the work — part creator, part archaeologist, endlessly digging through your own old decisions trying to understand what past-you was thinking.

Releasing Alpha 1.0 is the first time Silicon has existed outside my own head and hard drive. That's terrifying and exciting in equal measure.

If you're the kind of person who likes exploring new languages, who cares about extensibility and language design, who's ever wanted a small hackable environment for your side projects, I'd love for you to try Silicon. File issues when you hit bugs. Tell me what's confusing. Build something with Strata and show me what you made.

Silicon is small by design. What happens next is, in no small part, up to you.

---

*Silicon Alpha 1.0 is available now. The VSCode extension is available in the marketplace. Source, docs, and the playground are linked below.*
