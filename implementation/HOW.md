# HOW ?


## Web Browser API Compatibility

This will cover the implementation details and technique I am/will be/may be using to implement Silicon. I've been reading about
[WebIDL](https://webidl.spec.whatwg.org/#idl) which has a clear API spec for the web. This *should* help me verify that Silicon has 100% Web API compatibility. 

## NodeJS API Comptability

I'll likely leverage the [Typescript type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped) for all the Node APIs. I'll use a whichever Typescript parser works best. 


## CompTime 

This is more of a *WHAT* then a *HOW* but I wanted to capture the idea somewhere. ThePrimeagen mentioned it would be nice for `Zig` to allow `comptime` to actually generate `Zig` as an intermediate step for debugging and learning of compile time constructs in the language. I think this is a brilliant idea. Plus, one could then use that code output to run static code analysis etc. 


Thanfully, as of now, Silicon is using `Ohm.js` as the parser generator which has the idea of semantic rules. So I can have multiple implementations, one of which will do `comptime` evaluation on the Silicon AST then translate the AST back to Silicon. Doing this actually makes sense since I'll be doing a lot of AST manipulation later on when I add runtime meta-programming (LISP-style macros) to the language.


## Bootstrapping

I'll make this its own file later. Bootstrapping a programming language, initially, is pretty straightforward. The difficult part is what I call *incremental bootstrapping* which happens after the program initially rewrites the compiler in the language it compiles. If I add ternary to Silicon, then what? Do I have to do that 2-3 separate times? Sometimes, this would require updating the original stage 0 compiler written in C, then the bootstrapped version, or re-bootstrapping it multiple times etc. 

Thankfully, Silicon will take a different approach. Silicon will have a `bootstrap.si` file that is actually interpreted, not compiled. This file will do live AST manipulation **BEFORE** any other steps are performed. This is partially why the grammar is more "loosely" defined. The grammar needs to handle parsing potentially invalid keywords or other operators that are going to be added. Ideally, all future Silicon features just build off of existing one. Theoritically, this is possible if it is Turing complete. So fundamentally, `Silicon` the language will *NEVER* change, just the standard library will. 

My first step to bootstrapping Silicon will **NOT** be to rewrite the compiler. . . "What?". Yes, that is correct. In fact, I'm not going to rewrite it. I plan to implement `Ohm.js` in Silicon. I'll use the `Ohm PEG` grammar etc. I'll be sure to even make an even better playground for testing out grammars. The reason I would do this first, is then Silicon can be generated from PEG grammar. I want a grammar that actually defines the language, executable comments like Unit Tests.