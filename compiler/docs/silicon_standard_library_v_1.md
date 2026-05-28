# Silicon Standard Library v1

This document sketches a first version of the Silicon standard library. The goal is not to copy the public interface of C, Rust, Go, JavaScript, or WASI directly. Instead, Silicon should expose a stable, Silicon-native API while using WASM imports, WASI, browser APIs, Node APIs, C, Rust, or JavaScript behind curated adapters.

The library is organized into layers:

```text
core::       Minimal portable primitives and language-level types.
std::        Portable higher-level data structures and utilities.
runtime::    Implementation support for memory, panic, async, and platform glue.
platform::   WASI, browser, Node, and host-specific APIs.
interop::    Raw FFI helpers and generated bindings.
```

A rough dependency direction:

```text
core
  ↓
std
  ↓
runtime / platform / interop
```

`core` should avoid host assumptions. `std` should remain mostly portable. `platform` should contain APIs that require browser, Node, WASI, or custom host support. `interop` should contain lower-level generated or hand-written bindings that are not necessarily ergonomic.

---

# 1. Core primitives

Core primitives are the minimum values and operations Silicon needs to be usable. These should be available everywhere Silicon runs.

## Modules

```text
core::unit
core::bool
core::never
core::int
core::uint
core::float
core::char
core::tuple
core::record
core::function
core::compare
core::eq
core::hash
core::ordering
core::prelude
```

## Types

```silicon
Unit
Bool
Never

I8
I16
I32
I64

U8
U16
U32
U64

F32
F64

Char
Ordering
```

`Ordering` should probably be:

```silicon
Ordering = Less | Equal | Greater
```

## Primitive operations

Arithmetic and comparison should be exposed through operators, but ultimately elaborate to compiler intrinsics.

```silicon
+  -  *  /  %
== != < <= > >=
&& || !
```

These should not be implemented as ordinary host calls. They should lower directly to intrinsics such as:

```silicon
@intrinsic wasm::i32_add
@intrinsic wasm::i32_sub
@intrinsic wasm::i32_mul
@intrinsic wasm::i32_div_s
@intrinsic wasm::i32_eq
```

The public API should hide raw WASM operation names from normal user code.

## Core protocols / traits / constraints

Silicon will likely need a small set of built-in protocols or constraints:

```silicon
Eq<T>
Ord<T>
Hash<T>
Display<T>
Debug<T>
Clone<T>
Copy<T>
Drop<T>
Default<T>
```

These should be kept minimal. A large trait/protocol hierarchy too early would make the language feel heavier than necessary.

## Prelude

The prelude should import only extremely common types and functions.

```silicon
Unit
Bool
Never
I32
I64
U32
U64
F32
F64
String
Array
Slice
Option
Result
Ordering
```

Avoid automatically importing host-dependent functions such as `print`, `readFile`, or `fetch`.

---

# 2. Option / Result

`Option` and `Result` should be central to Silicon error and absence handling. They should avoid exceptions and work well with static analysis.

## Modules

```text
core::option
core::result
```

## Option

```silicon
Option<T> = Some<T> | None
```

Core operations:

```silicon
Option::isSome option
Option::isNone option
Option::unwrap option
Option::unwrapOr option default
Option::map option fn
Option::flatMap option fn
Option::filter option predicate
Option::or option fallback
Option::orElse option fallbackFn
```

Possible syntax sugar later:

```silicon
value?       ## early return on None
```

But the first version can avoid syntax sugar and use explicit functions.

## Result

```silicon
Result<T, E> = Ok<T> | Err<E>
```

Core operations:

```silicon
Result::isOk result
Result::isErr result
Result::unwrap result
Result::unwrapOr result default
Result::map result fn
Result::mapErr result fn
Result::flatMap result fn
Result::or result fallback
Result::orElse result fallbackFn
```

Possible syntax sugar later:

```silicon
value!       ## early return on Err
```

But the first version should keep this explicit until the error/effect model is stable.

## Relationship to effects

`Result` should handle recoverable domain errors.

Capabilities/effects should describe external permissions and side effects:

```silicon
@fn readConfig path: String
  @requires FileSystem
  : Result<Config, ConfigError>
```

This says:

```text
The function requires filesystem capability.
The function may fail with ConfigError.
```

Those are related, but not the same thing.

---

# 3. String / Array / Slice

Strings, arrays, and slices form the practical foundation of most Silicon programs.

## Modules

```text
core::string
core::array
core::slice
core::char
core::bytes
std::text
```

## String

Silicon has previously leaned toward UTF-16 strings for JavaScript interoperability. The public API should expose Unicode-aware behavior without forcing users to think about the backing representation constantly.

```silicon
String
Char
Utf8
Utf16
Bytes
```

Core string operations:

```silicon
String::empty
String::length string
String::isEmpty string
String::concat left right
String::slice string start end
String::contains string pattern
String::startsWith string prefix
String::endsWith string suffix
String::indexOf string pattern
String::trim string
String::toUtf8 string
String::fromUtf8 bytes
String::toUtf16 string
String::fromUtf16 units
```

Important distinction:

```text
String::length       should have clearly documented units.
String::charLength   Unicode scalar count, if supported.
String::byteLength   UTF-8 byte count, if needed.
String::unitLength   UTF-16 code unit count, if using UTF-16 internally.
```

For v1, Silicon should choose one default meaning for `String::length` and expose the others explicitly.

Recommended:

```silicon
String::length string       ## user-facing character/scalar count, if feasible
String::unitLength string   ## UTF-16 code units
String::byteLength string   ## UTF-8 byte length after encoding
```

If character counting is too expensive or complex for v1, make `String::length` mean UTF-16 code units and document it clearly.

## Array

```silicon
Array<T>
```

Operations:

```silicon
Array::empty<T>
Array::length array
Array::isEmpty array
Array::get array index
Array::set array index value
Array::push array value
Array::pop array
Array::append left right
Array::slice array start end
Array::map array fn
Array::filter array predicate
Array::fold array initial fn
Array::forEach array fn
```

Because Silicon prefers immutability, operations such as `set`, `push`, and `pop` need clear semantics.

Possible split:

```silicon
Array::push array value       ## returns a new array
Array::pushMut array value    ## mutates in place, requires mutable context
```

Or, using Silicon-style mutation:

```silicon
@mut Array::push array value
```

For v1, prefer explicit mutable variants or `@mut`-gated APIs.

## Slice

```silicon
Slice<T>
MutSlice<T>
```

Operations:

```silicon
Slice::length slice
Slice::isEmpty slice
Slice::get slice index
Slice::sub slice start end
Slice::toArray slice

MutSlice::set slice index value
MutSlice::fill slice value
MutSlice::copyFrom target source
```

`Slice<T>` should be a view into existing memory. It should not own memory.

## Bytes

Because WASM and FFI frequently operate on raw byte buffers, bytes deserve a first-class type.

```silicon
Bytes = Slice<U8>
ByteArray = Array<U8>
```

Operations:

```silicon
Bytes::length bytes
Bytes::get bytes index
Bytes::toUtf8 bytes
Bytes::fromUtf8 string
Bytes::copy bytes
```

---

# 4. Memory / allocator model

Memory is one of Silicon’s most important design areas because it targets WASM and aims for low runtime overhead.

## Modules

```text
core::memory
core::ptr
core::ref
core::box
core::arena
core::allocator
runtime::memory
runtime::allocator
```

## Types

```silicon
Ptr<T>
Ref<T>
MutRef<T>
Box<T>
Arena
Allocator
AllocationError
```

Possible allocator interface:

```silicon
Allocator::alloc allocator size alignment : Result<Ptr<U8>, AllocationError>
Allocator::free allocator ptr
Allocator::resize allocator ptr oldSize newSize alignment : Result<Ptr<U8>, AllocationError>
```

A safer public API should avoid exposing raw pointers except in low-level code.

## Suggested layers

```text
core::memory      safe abstractions
runtime::memory   actual WASM memory implementation
interop::memory   raw pointer and ABI helpers
```

## Allocation-aware APIs

Any function that allocates should either use the default allocator or accept an allocator capability.

```silicon
@fn Array::push array: Array<T>, value: T
  @requires Allocator
  : Result<Array<T>, AllocationError>
```

If Silicon supports module-level allocators, most user code should not need to pass allocators manually.

## Default memory model for v1

For the first standard library version, choose one default memory model and keep the rest experimental.

Recommended v1 path:

```text
1. Start with a simple bump allocator for early compiler/runtime work.
2. Add a general-purpose allocator for long-running programs.
3. Add arenas for scoped allocation.
4. Add ARC or ownership-like optimizations later if needed.
```

## WASM memory assumptions

Silicon should hide most linear-memory details from normal code, but the runtime must define:

```silicon
runtime::memory::pageSize
runtime::memory::grow pages
runtime::memory::size
```

These can map to WASM memory operations.

---

# 5. Debug / assert / panic

Debugging utilities should be available early, even if primitive.

## Modules

```text
core::debug
core::assert
core::panic
std::debug
runtime::panic
```

## APIs

```silicon
Debug::format value : String
Debug::inspect value : String

assert condition
assertEqual left right
assertNotEqual left right

todo message
unreachable message
panic message
```

## Panic model

Silicon should distinguish between:

```text
recoverable error     Result<T, E>
programmer mistake    panic / assert / unreachable
impossible path       unreachable
unfinished code       todo
```

Possible APIs:

```silicon
Panic::panic message : Never
Panic::todo message : Never
Panic::unreachable message : Never
```

`Never` lets the type system know the function does not return.

## Runtime behavior

Panic behavior should be configurable by target:

```text
browser: console error + trap
Node: stderr + trap/throw
WASI: stderr + exit/trap
embedded host: host-defined panic handler
```

The standard API should remain stable even if the backend behavior differs.

---

# 6. WASM imports/exports model

Silicon should have first-class support for WASM imports and exports, but raw WASM should not dominate ordinary user code.

## Modules

```text
core::wasm
runtime::wasm
interop::wasm
```

## Exports

Silicon should allow functions to be exported from a WASM module.

Possible syntax:

```silicon
@export "add"
@fn add x: I32, y: I32 : I32 =
  x + y
```

This should compile to a WASM export roughly equivalent to:

```wat
(func $add (param $x i32) (param $y i32) (result i32)
  local.get $x
  local.get $y
  i32.add)
(export "add" (func $add))
```

## Imports

Silicon should allow host functions to be imported explicitly.

Possible syntax:

```silicon
@import "env" "console_log"
@fn rawConsoleLog ptr: I32, len: I32 : Unit
```

This would map to WAT like:

```wat
(import "env" "console_log" (func $rawConsoleLog (param i32 i32)))
```

## Raw import layer

Raw imports should live under an explicit namespace:

```text
interop::wasm::raw
```

Public wrappers should live elsewhere:

```text
platform::browser::console
platform::node::console
platform::wasi::stdio
std::io
```

## ABI types

The WASM layer should define ABI-safe types:

```silicon
WasmI32
WasmI64
WasmF32
WasmF64
WasmPtr<T>
WasmLen
```

These should probably be aliases or wrappers over Silicon primitives, but the names clarify ABI boundaries.

---

# 7. Console output

Console output is useful for early development, examples, debugging, and playgrounds. It should not be part of pure `core` because it requires host interaction.

## Modules

```text
std::console
std::io
platform::browser::console
platform::node::console
platform::wasi::stdio
```

## API

```silicon
Console::log value
Console::info value
Console::warn value
Console::error value
Console::debug value
```

These likely require a capability:

```silicon
@fn main
  @requires Console
=
  Console::log "Hello, Silicon"
```

## Text output abstraction

A more general output abstraction should exist below or beside console:

```silicon
Writer
Stdout
Stderr

Writer::write writer bytes : Result<Unit, IOError>
Writer::writeText writer text : Result<Unit, IOError>
```

Then console can be implemented in terms of host console APIs or stdio depending on the platform.

## Playground support

The Silicon playground can provide its own imports:

```text
env.console_log(ptr, len)
env.console_error(ptr, len)
```

The stdlib wrapper should hide these raw details.

---

# 8. WASI/browser/Node platform adapters

Platform adapters expose host capabilities in a Silicon-shaped way.

## Modules

```text
platform::wasi
platform::browser
platform::node
platform::host
```

## WASI

```text
platform::wasi::filesystem
platform::wasi::stdio
platform::wasi::clocks
platform::wasi::random
platform::wasi::streams
platform::wasi::sockets
```

Possible APIs:

```silicon
FileSystem::readText path : Result<String, IOError>
FileSystem::writeText path text : Result<Unit, IOError>
FileSystem::exists path : Bool
FileSystem::remove path : Result<Unit, IOError>
Clock::now : Instant
Random::bytes len : Result<ByteArray, RandomError>
```

## Browser

```text
platform::browser::console
platform::browser::dom
platform::browser::fetch
platform::browser::storage
platform::browser::canvas
platform::browser::events
platform::browser::timers
```

Possible APIs:

```silicon
Fetch::get url : Result<Response, NetworkError>
Fetch::post url body : Result<Response, NetworkError>
Document::query selector : Option<Element>
Element::setText element text
Element::addClass element className
LocalStorage::get key : Option<String>
LocalStorage::set key value : Result<Unit, StorageError>
Timer::setTimeout duration callback
```

## Node

```text
platform::node::fs
platform::node::path
platform::node::process
platform::node::buffer
platform::node::crypto
platform::node::http
platform::node::timers
```

Possible APIs:

```silicon
NodeFs::readText path : Result<String, IOError>
NodeFs::writeText path text : Result<Unit, IOError>
Process::args : Array<String>
Process::env name : Option<String>
Crypto::randomBytes len : Result<ByteArray, CryptoError>
```

## Host abstraction

A portable application should depend on abstract capabilities:

```silicon
FileSystem
Console
Clock
Random
Network
Storage
```

Then the platform adapter provides implementations:

```text
platform::wasi implements FileSystem, Console, Clock, Random
platform::browser implements Console, Clock, Random, Network, Storage
platform::node implements FileSystem, Console, Clock, Random, Network
```

This keeps Silicon code portable when possible.

---

# 9. Collections

Collections should live mostly in `std`, not `core`, except for arrays and slices.

## Modules

```text
std::collections
std::collections::list
std::collections::map
std::collections::set
std::collections::queue
std::collections::stack
std::collections::deque
std::collections::priorityQueue
```

## Types

```silicon
List<T>
Map<K, V>
Set<T>
Queue<T>
Stack<T>
Deque<T>
PriorityQueue<T>
```

## Map

```silicon
Map::empty<K, V>
Map::length map
Map::isEmpty map
Map::get map key : Option<V>
Map::set map key value : Map<K, V>
Map::remove map key : Map<K, V>
Map::containsKey map key : Bool
Map::keys map : Array<K>
Map::values map : Array<V>
Map::entries map : Array<Tuple<K, V>>
```

Mutable variants can be added later or gated behind `@mut`.

```silicon
@mut Map::set map key value
@mut Map::remove map key
```

## Set

```silicon
Set::empty<T>
Set::length set
Set::contains set value : Bool
Set::add set value : Set<T>
Set::remove set value : Set<T>
Set::union left right : Set<T>
Set::intersection left right : Set<T>
Set::difference left right : Set<T>
```

## Queue / Stack

```silicon
Queue::empty<T>
Queue::push queue value
Queue::pop queue : Option<Tuple<T, Queue<T>>>

Stack::empty<T>
Stack::push stack value
Stack::pop stack : Option<Tuple<T, Stack<T>>>
```

## Implementation note

For v1, collections can be simple and correct rather than heavily optimized.

Possible order:

```text
1. Array-backed List
2. HashMap
3. HashSet
4. Queue
5. Stack
6. Deque
7. PriorityQueue
```

---

# 10. JSON / text utilities

JSON is important for browser, Node, WASI tools, APIs, config files, and Silicon playgrounds.

## Modules

```text
std::json
std::text
std::text::builder
std::text::format
std::text::encoding
std::text::regex
```

## JSON type

```silicon
Json =
  JsonNull
  | JsonBool<Bool>
  | JsonNumber<F64>
  | JsonString<String>
  | JsonArray<Array<Json>>
  | JsonObject<Map<String, Json>>
```

## JSON operations

```silicon
Json::parse text : Result<Json, JsonParseError>
Json::stringify json : String
Json::get json key : Option<Json>
Json::at json index : Option<Json>
Json::asString json : Option<String>
Json::asNumber json : Option<F64>
Json::asBool json : Option<Bool>
Json::asArray json : Option<Array<Json>>
Json::asObject json : Option<Map<String, Json>>
```

## Typed JSON encoding/decoding

Later, Silicon can support derived encoders/decoders:

```silicon
Json::decode<T> json : Result<T, JsonDecodeError>
Json::encode<T> value : Json
```

This should likely be implemented through compile-time derivation or elaboration hooks.

## Text utilities

```silicon
Text::split text separator : Array<String>
Text::join parts separator : String
Text::replace text old new : String
Text::lines text : Array<String>
Text::words text : Array<String>
Text::toLower text : String
Text::toUpper text : String
```

## StringBuilder

Because repeated string concatenation can be expensive:

```silicon
StringBuilder
StringBuilder::new
StringBuilder::append builder text
StringBuilder::appendLine builder text
StringBuilder::toString builder
```

This may require allocation capability.

---

# 11. Async / coroutines / platform event loop

Silicon’s async model should be designed around explicit state machines and platform adapters. Since Silicon targets WASM, async cannot be treated as just a language keyword. It must coordinate with the host event loop.

## Modules

```text
core::future
core::coroutine
std::async
std::task
std::stream
runtime::async
runtime::eventLoop
platform::browser::eventLoop
platform::node::eventLoop
platform::wasi::eventLoop
```

## Core types

```silicon
Future<T>
Task<T>
Coroutine<Yield, Return>
Promise<T>
CancellationToken
```

## Basic APIs

```silicon
Future::map future fn : Future<U>
Future::flatMap future fn : Future<U>
Future::await future : T

Task::spawn fn : Task<T>
Task::cancel task : Unit
Task::result task : Option<Result<T, TaskError>>

Coroutine::resume coroutine input : CoroutineState<Yield, Return>
Coroutine::yield value
```

## Coroutine state

```silicon
CoroutineState<Yield, Return> =
  Yielded<Yield>
  | Complete<Return>
```

## Event loop abstraction

```silicon
EventLoop::spawn task
EventLoop::run
EventLoop::sleep duration : Future<Unit>
EventLoop::nextTick : Future<Unit>
```

## Platform mapping

```text
browser: JavaScript promises, microtasks, timers, DOM events
Node: JavaScript promises, process.nextTick, timers, fs/network async APIs
WASI: pollable resources, clocks, streams, possibly WASI Preview 2/component model
custom host: explicit imported functions
```

## v1 recommendation

Do not start with a huge async runtime.

Start with:

```text
1. Callback imports from JS host.
2. Minimal Future<T> representation.
3. Timer/sleep support in browser and Node.
4. Async host call wrapper.
5. Coroutine state-machine lowering.
6. Task spawning later.
```

This keeps the compiler and runtime manageable.

---

# Additional recommended groups

The original list is a good start. Silicon will probably also need these standard-library areas.

---

# 12. Time and duration

## Modules

```text
std::time
platform::wasi::clocks
platform::browser::time
platform::node::time
```

## Types

```silicon
Duration
Instant
DateTime
TimeZone
```

## APIs

```silicon
Duration::fromMillis millis
Duration::fromSeconds seconds
Duration::toMillis duration

Clock::now : Instant
Clock::dateTimeNow : DateTime
Instant::elapsed instant : Duration
```

Keep precise monotonic time separate from human calendar time.

---

# 13. Math

## Modules

```text
std::math
```

## APIs

```silicon
Math::min a b
Math::max a b
Math::abs value
Math::clamp value min max
Math::sqrt value
Math::sin value
Math::cos value
Math::tan value
Math::floor value
Math::ceil value
Math::round value
```

Integer operations should mostly stay in `core`. Higher-level numeric utilities can live in `std::math`.

---

# 14. Filesystem and paths

Filesystem access should be capability-gated and platform-backed.

## Modules

```text
std::fs
std::path
platform::wasi::filesystem
platform::node::fs
```

## APIs

```silicon
Path
File
Directory
FileMode

Path::join parts : Path
Path::parent path : Option<Path>
Path::fileName path : Option<String>
Path::extension path : Option<String>

FileSystem::readText path : Result<String, IOError>
FileSystem::writeText path text : Result<Unit, IOError>
FileSystem::readBytes path : Result<ByteArray, IOError>
FileSystem::writeBytes path bytes : Result<Unit, IOError>
FileSystem::exists path : Bool
FileSystem::remove path : Result<Unit, IOError>
```

Browser builds may not support these directly, except through file picker APIs or virtual filesystems.

---

# 15. Network and HTTP

Network APIs should not be part of `core`. They should be capability-gated and platform-specific under the hood.

## Modules

```text
std::http
platform::browser::fetch
platform::node::http
platform::wasi::sockets
```

## Types

```silicon
Url
Request
Response
Headers
HttpMethod
StatusCode
NetworkError
```

## APIs

```silicon
Http::get url : Future<Result<Response, NetworkError>>
Http::post url body : Future<Result<Response, NetworkError>>
Response::status response : StatusCode
Response::text response : Future<Result<String, NetworkError>>
Response::json response : Future<Result<Json, NetworkError>>
```

---

# 16. Testing

A language needs a testing story early.

## Modules

```text
std::test
```

## APIs / annotations

```silicon
@test
@fn additionWorks =
  assertEqual 4 (2 + 2)
```

Potential test helpers:

```silicon
Test::assert condition
Test::assertEqual left right
Test::assertNotEqual left right
Test::fail message
```

Testing should integrate with the compiler and runner rather than just being an ordinary library.

---

# 17. Generated and raw interop

Generated bindings should not be the main public stdlib. They should live in raw namespaces.

## Modules

```text
interop::wasm
interop::c
interop::rust
interop::js
vendor::web
vendor::node
vendor::wasi
```

## Purpose

```text
interop::wasm   raw WASM imports/exports and ABI helpers
interop::c      C ABI compatibility helpers
interop::rust   Rust-generated WASM interop helpers
interop::js     JavaScript value and callback interop
vendor::web     generated Web IDL bindings
vendor::node    generated TypeScript declaration bindings
vendor::wasi    generated WIT/WASI bindings
```

Public APIs should wrap these lower-level bindings.

---

# Proposed initial implementation order

The first working standard library should be small and practical.

## Phase 1: Minimal core

```text
Unit
Bool
I32
I64
F32
F64
String placeholder
Array placeholder
Option
Result
assert
panic
```

## Phase 2: WASM runtime basics

```text
WASM imports
WASM exports
linear memory helpers
simple allocator
string ABI passing
console output
```

## Phase 3: Usable data model

```text
String
Array
Slice
Bytes
Debug formatting
basic text functions
```

## Phase 4: Platform adapters

```text
browser console
Node console
WASI stdio
browser fetch
Node fs
WASI fs
```

## Phase 5: Higher-level std

```text
Map
Set
List
JSON
StringBuilder
Time
Path
Filesystem
HTTP
```

## Phase 6: Async/coroutines

```text
Future
Coroutine
EventLoop abstraction
browser Promise adapter
Node Promise adapter
WASI poll adapter
Task spawning
```

---

# Design principles

## 1. Public APIs should be Silicon-native

Do not expose raw C, Rust, JavaScript, or WASI interfaces as the primary standard library.

Use this pattern:

```text
raw host API
  ↓
interop/vendor binding
  ↓
platform adapter
  ↓
std/core public API
```

## 2. Capabilities should mark host effects

Functions that touch the outside world should be explicit.

```silicon
@fn readText path: Path
  @requires FileSystem
  : Result<String, IOError>
```

## 3. Allocation should be visible to the compiler

Functions that allocate should be trackable, even if users do not manually pass allocators everywhere.

```silicon
@fn concat left: String, right: String
  @requires Allocator
  : Result<String, AllocationError>
```

The compiler can optimize this away when statically known.

## 4. Keep `core` small

`core` should define the semantic foundation. It should not become a giant convenience library.

## 5. Keep generated bindings separate

Generated bindings are useful, but they are not the design of the language.

## 6. Prefer stable semantic contracts over implementation reuse

Silicon can FFI into C, Rust, JS, or WASI, but its standard library should define Silicon’s own semantic contracts.

---

# Open design questions

These should be decided before the stdlib becomes stable.

1. What exactly does `String::length` mean: UTF-16 code units, Unicode scalar values, grapheme clusters, or something else?
2. Are arrays immutable by default with separate mutable variants?
3. How does `@mut` appear in stdlib function definitions?
4. Does allocation use a module-level default allocator, explicit allocator parameters, or capability injection?
5. Is `panic` allowed in all build modes?
6. Are `Option::unwrap` and `Result::unwrap` included, or discouraged?
7. How much of WASM import/export syntax belongs in the language versus the stdlib?
8. Should `Console` be a capability, a module, or both?
9. Should browser, Node, and WASI APIs share abstract capabilities such as `FileSystem`, `Clock`, `Random`, and `Network`?
10. Should async be based on `Future`, coroutine state machines, or both?
11. Should JSON encoding/decoding be library-based, compiler-derived, or elaborator-derived?
12. How much of the stdlib should be written in Silicon versus provided as compiler/runtime intrinsics?

---

# Summary

The first Silicon standard library should probably be:

```text
core::       primitives, Option, Result, String, Array, Slice, basic protocols
std::        collections, JSON, text, math, time, filesystem abstractions, HTTP abstractions
runtime::    allocator, memory, panic, async/event-loop support
platform::   browser, Node, WASI adapters
interop::    raw generated bindings and ABI helpers
```

The core rule is:

```text
Copy existing standard libraries as research checklists, not as public API contracts.
```

Silicon’s standard library should express Silicon’s semantics: WASM-first compilation, capabilities, static analysis, explicit allocation, safe platform boundaries, and low runtime overhead.

