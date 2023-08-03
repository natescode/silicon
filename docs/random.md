## Memory

Silicon defaults to using the stack aka `local` and `immutable` for all memory. Only memory
tagged with `@global` or `@mutable` live on the stack. Any non-local memory automatically uses reference counting.
Reference counting is easy to use, has low runtime overhead and is fairly fast.

## True Colorless async

Rust, Java, C# etc all use `async / await`. An async function can call a sync function but not the otherway around because they only have
singe call stacks.

Go does have independent call stacksa you don't have to declare a function as sync or async BUT if you call it async, then you have to pass in a channel.

### Silicon Async

```silicon
    $temp_1 = getTemp
    $temp_2 = @co getTemp

    @fn getTemp
        std::curl "api.weather.com/temp"
    @
```

Notice there are NO `async` definitions on function. They don't exist, explicitly nor implicitly. Silicon has separate call stacks so we can mix async and sync functions.

ALSO, unlike Go, we can make a coroutine that returns data without having to refactor the function to accept a channel parameter then use `<-` syntax to read from the channel.

```silicon

@fn count_to_n:ints n
    $nums = []
    @for 1..n
        n
    @
    nums
@
count_to_n 10 // [1,2,3,4,5,6,7,8,9,10]

// this is different because `yield` / `return` is in the for loop
@fn count_to_n_async:ints n
    @for 1..n
        @yield n
    @
@

@co count_to_n_async 10 // 1
@co count_to_n_async 10 // 2
@co count_to_n_async 10 // 3
// and so on





```

maybe like this?

```silicon
    @fn count_to_n n
        @for 1..n
            n
        @
    @

    $to_ten = count_to_n 10 // [1,2,3,4,5,6,7,8,9,10]
    $to_ten_async = @co count_to_n 10 // [1,2,3,4,5,6,7,8,9,10]
```

BUT if you want yielding and pause/resume then you must be explicit

I.E generator

```silicon
    @fn count_to_n n
        @for 1..n
            @yield n
        @
    @

    // blocking generator
    $to_ten = count_to_n 10 // 1

    // non-blocking generator
    $to_ten_async = @co count_to_n 10 // 1
```

versus yielding the completed collection which is implicit

```silicon
    @fn count_to_n n
        // @yield is normally implied without the keyword
        // since `for` or `loop` are expressions.
        // Same as `map` in this case
        // return is implied before for since that is the last expression
       @for 1..n
            @yield n
        @
    @

    $to_ten = count_to_n 10 // [1,2,3,4,5,6,7,8,9,10]

    // non-blocking, streamable with Vectors?
    $to_ten_async = @co count_to_n 10 // 1
    $to_ten_async = @co count_to_n    // 2
    $to_ten_async = @co count_to_n    // 3
```

~~`@co` wraps a function call inside a new coroutine and then calls it.~~

Similar to this Lua.

```lua

     function co(fn)
        cor = coroutine.create(fn)

        coroutine.resume(cor)
        return cor
     end

    function print_to_ten()
        for i=1,10 do
            print("co", i)
            coroutine.yield()
        end
    end

    co(print_to_ten)

```

But MUCH cleaner. If we want to make a coroutine but not run it immediately then we can do

which is just a code block that isn't evaluated yet. `QUOTE` in LISP

```
$coroutine = co::new 'count_to_ten 10'

//coroutine.resume
coroutine

```

The `'code here'` is QUOTING like LISP where we can pass a block of code without evaluating it yet, ~~basically a function without parameters~~

> still debating if # is for function calls, references or what

`#` for reference? Instead of `int*` it would be `#:int` versus `@ptr:int`

## Coroutine

```silicon
// new coroutine
@let co_count = coroutine::new 'count_to_n 10'
co_count.resume // 1

// call function async
@co count_to_n 10

```

## Auto Coroutines `@co`

Auto coroutines are scheduled much like `async ... await` in than sense. \

## Expressions, Expressions everywhere

All expressions is `silicon` are `function`. That means `@for` is not only an expressions but a function as well.

```silicon
    @fn with loop, body
        loop
    @

    @fn ten_times body => @partial @for 1..10, body

    with ten_times,
    with ten_times,
    {
        print "hi"
    }

    // prints "hi" 100 times

    @fn doubleFor X_MAX, Y_MAX
        @for 0..X_MAX,
        @for 0..Y_MAX,
        body X,Y
    @


    doubleFor 5,7, \x,y => print `{X},{Y}`
    // prints
    // 0,0
    // 1,0
    // 2,0
    // ....
    // 0,1
    // 1,1
    // 2,2

```

## Effects

- `total`
- `exn`
- `div`
- `console`
- `ndet`

`pure` = `exn` + `div`

```
fun sqr    : (int) -> total int       // total: mathematical total function
fun divide : (int,int) -> exn int     // exn: may raise an exception (partial)
fun turing : (tape) -> div int        // div: may not terminate (diverge)
fun print  : (string) -> console ()   // console: may write to the console
fun rand   : () -> ndet int           // ndet: non-deterministic
```
