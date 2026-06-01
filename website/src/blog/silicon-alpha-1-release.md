# Silicon's Publicly Released!

I'm happy to announce Alpha 1 of Silicon is available! Silicon is my passion project. I've been desiging it and revising it for years. I've finally focused and delivered a complete albeit simple ecosystem for my programming language. I'm not just releasing a toy compiler for my toy language. I'm releasing the compiler, cli, playground, docs, examples, and vscode extension! 

Grab your favorite beverage. Let's go over everything I've been working on.

## Origin

I started by work on Silicon, originally called SillyScript, 8 years ago in 2018. I had read "Writing an Interpreter in Go", "Crafting Interpreters", and several other books on Compilers, and interpreters. I wrote several versions of a basic interpreter and compiler for Silicon. One version was in C#; the language I use professionally. My work on Silicon was sporatic. 

Years later I found Ohm.js and that allowed me to quickly iterate on my grammar and build a basic compiler quickly. The first version compiled to JavaScript. Then I added WASM as the target. Actually it was WAT since WAT text is easier to debug. The main reason for the hiatus on development wasn't due to lack of skill, I had already built that up, but lack of clear direction. I had no *WHY* for Silicon. I read [Jonathan Goodwin's](https://pling.jondgoodwin.com/post/gradual-memory-management/) paper on Gradual Memory Management and thought it would be cool to implement that. Unfortunately, that was a very specific language feature and not a real User Story. I eventually decided I wanted my own personal programming language for scripting and building side project that could replace ECMAScript (or JavaScript, Oracle please don't sue me). I finally had a general direction.

## Keep it Simple. Keep it Safe. 

Silicon is inspired by several languages. I love Lisp for its elegance. I love Go for being simple. I love Zig for being low level. Crablang provides strong memory safety without runtime overhead. None of them really fit. Unfortunately for quick fun languages Typescript was as close as I could get. 

I wanted a more flexible but mimimal language. I wanted a language that could provide safety but could also give the user full power when desired.

I started with the grammar. The reason the compiler is named Sigil is because the language uses several Sigils, or little characters to characterize identifiers. @ denotes a keyword. @@ an annotation. $ is a compiler native API. & evaluates an expression or function. I wanted the grammar to be easy to parse, LL(1) to be exact. I didn't always, I still don't, like some of Silicon's syntax but syntax is there to serve the compiler, and tooling. 

If Silicon was going to be this small but multi-paradigm programming language, it'll need at least one super power. An idea. That idea is Syntax doesn't define Semantics.

## Syntax != Semantics

This is the idea that powers the main novel feature of Silicon. What happens when a language needs to add a new feature? Many added async/await after C# did. They added new keywords async,await. Those keywords could collide with existing identifiers. Every new feature adds new syntax. ECMAScript aka JavaScript seems to add new syntax constantly. Much of it is syntax sugar giving us syntatical diabetes. Another take on this is the oxidized language, it heavily uses macros which basically turn it into a DSL, slow build times, and pollute the language in a different way. On the other side of the spectrum is Go. Go is been suprisingly resistent to syntax sugar and new features in general. Personally, I feel like Golang is just 30 years away from becoming Java. What other solution is there? You either add new semantics via new syntax or through macros, or you don't. I decided to make something beyond macros, Strata.

## Strata


First, like I said before Silicon doesn't define a preset list of keywords or operators. That means new keywords ande operators may be added without changing the actual defined syntax of the language. I call this a loose grammar meaning the syntax can describe more than the semantics. You could write @oogabooga and it'll parse just fine. It will literally mean nothing and compile to nothing but it's syntactically correct while being semantically empty.

What are Strata? First, they are **NOT** Macros. Don't use the **M** word here. A stratum is a vertical compiler extension. Think of it like a video game mod but for a programming language. Modern compilers like Roselyn are moduler and have APIs. Sigil is a CaaS (Compiler as a Service). The compiler exposes the parser, elaborator, type system, codegen etc to the language. 

Sigil (the compiler) actually only understands a language called Silicon Core. That language is not [Turing Complete](https://en.wikipedia.org/wiki/Turing_completeness). Sounds useless BUT since the Silicon Core does have the ability to call the compiler APIs it can build itself up to become what I call Silicon. You're welcome to fork Sigil and make your own language! That's the whole point. Sigil isn't Silicon's compiler, hence the separate name. It is really a toolkit with a small DSL that can be used to build anything. 

Silicon has dozens of Strata already defined. For example, Silicon Core doesn't even have the concept of addition. Silicon Core defines patters (regex) of operators and keywords but nothing specific. Keywords are just @ plus a valid identifier. Operators are symbols groups of one or more symbols like ^%#*~.  

Now Starta may be like superpowered Macros but they still have they downside of making the language too big. The geal isn't for everyone to make Strata like people make npm packages. The goal is to allow groups of Strata, called Profiles that make Silicon flavored like your favorite language. 

## The Right Tools

Strata could become overused and then we have syntatical diabetes much like languages that overuse macros. That's why I'm tried to only add orthogonal language features (or at least design them. They're not implemented yet).

On top of that, I've tried to make Silicon lean on the shoulder's of giants. The main target is [WebAssembly](https://webassembly.org/) this provides write once, run anywhere including the browser. Targeting WASM means I don't need to optimize the binary, run it etc. WASI provides interfaces for multiple platforms. Silicon uses [QBE](https://c9x.me/compile/) to compile to native binaries for *nix systems. It then can use C APIs. 

## Many APIs. One Language.

- C APIs on native
- Browser APIs
- Node APIs
- Bun APIs
- WASI
- Custom APIs via extern functions.

## Resources

[Playground](play.si14.dev)
[Website](si14.dev)
[Blog](blog.si14.dev)
[VScode extension](https://marketplace.visualstudio.com/items?itemName=natescode.silicon-vscode)
[repo](https://github.com/natescode/silicon)


## Blogs

I will post updates to

[Silicon's official blog](blog.si14.dev)
[Medium](https://medium.com/@natescode)
[Substack](https://substack.com/@natescode)
[NatesCode blog](natescode.com)
[Dev.to](https://dev.to/natescode)
[YouTube vlogs](https://www.youtube.com/@natescode)


## Contact Me

I'm NatesCode literally everywhere: Reddit, Twitch, YouTube, Medium, Snapchat etc. 

For Silicon specifically you can email me: nate at natescode.com. I'll eventually setup a Silicon discord. I do have a Zulip but that'll be for when I'm ready for more contributors. 

