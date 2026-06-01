\* Likely use Algebraic Effects / Co-routines
# Concurrency

Concurrency is difficult. Most enterprise programming languages use `async / await`. Which works well enough and can easily have a stack-based implementation.

Silicon wants to do something better. `Go` uses CSP with channels. The main improvement over `async / await` is that this means no [colored functions](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/) because `Go` has multiple execuction stacks.

This is pretty similar BUT still inferior to proper _coroutines_ like in `Lua` or _fibers_ in `Ruby` which also have their own execution stacks. Those implementations, like _processes_ in `Elixir` allow for distributed computing models. `Elixir` uses the [Actor Model](https://en.wikipedia.org/wiki/Actor_model) which is just more restrictive than channels. Actors communicate directly with one another, like OOP. Versus through channels, which reminds me of queues. Channels allow a simple [pub/sub](https://learn.microsoft.com/en-us/azure/architecture/patterns/publisher-subscriber) model.

Coroutines can call other coroutines, they don't yield to any "parent" but pass data. They are co-operative routines after-all. They're asymmetrical meaning there are separate methods for resuming and pausing a coroutine.

> "Actors are a combination of a Coroutine and a Channel. You can send information off to an actor. The actor operates within a Coroutine and reads from that channel to process work. Channels are the way for you to communicate safely between Coroutines."

Actors typically communicate directly to each other via their 'mailbox' but maybe that 'mailbox' aka channel could be shared? This decouples actors from one another.

Actors can only send one message directly to one other actor.
Actor <-> Actor

Goroutines may talk via typed channels (first class constructs) which may have _many_ Goroutines listening in on that channel. Basically a shared 'mailbox' in Actor model lingo.

Goroutine(s) <-> Channel <-> Goroutine(s)

coroutine_1 -> channel_A -> coroutine_2
courtine_2 -> channel_A -> coroutine_1

## thoughts

Some say Lua's coroutines are better, others say Go's are better. Go's goroutines can't be paused or resumed like Lua's, nor passed around.

## _Crystals_

Silicon's coroutines are called _Crystals_. Mainly because that fits the theme AND a separate term can capture its unique semantics and features without confusing them with other co-routine implementations.

### _channel_

Silicon has typed channels. Channels are the intermediary. Crystals may subscribe to 0 or more channels. Crystals can act like Actors which means they _can_ communicate directly if desired.

### _crystal_

Crystals are coroutines, green threads. They CAN run in separate OS threads but they don't have to. They are managed by the runtime, not the OS. Coroutines have three methods: _resume()_, _pause()_, and _status()_. Coroutines can be passed as well. They may subscribe to 0 or more _channels_ as well. Crystals can communicate across machines and domains I.E client <-> server.

They each of a ` pid`` or processor id. They may be addressed directly or indirectly through an associated  `channel`.

```
@let countingChannel = new chan();
@let count:co = new co(countingChannel)
count.resume()
```

## sRPC

`std` contains a library for `RPC`. This allows for functions or crystals to communicate across boundaries.

## CFRDT ?

[Conflict-free replicated data-type](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type)
