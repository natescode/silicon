# Capabilities 

`Silicon` is heavily inspired by ML languages and functional languages. Silicon is pure by default.

Silicon uses **Capabilities** to handle [side-effects]() (Logging, Errors, IO etc).

## Capabilities

Capabilities are conceptually very simple. They're basically permissions in the form an interface that is passed
to a function or module. 

Silicon functions cannot access anything but their argument. This means functions can only perform side-effects
that they're explicitly given.


_Capabilities_ are part of a secondary type system. They represent side effects that a function may have, such as returning and error, never haulting, 
allocating memory etc. 


### Capabilities Example

Here is a simple hello,world example.

```silicon
#declare capability
@capability PRINT message:string = {
  # call the platform / environment (browser in this case) specific print function
  &env::console_log message;
}

# declare function with capability it requires
# string -> string
@fn greet:string message:string, print:@capability = {
  &print message
  @return message;
}

# call function and pass the capability
&greet "hello,world!", PRINT

# use `Console.log` for printing
&greet "hello,world!", SI::CAPABILITIES::WEB::CONSOLE_LOG

# use `Console.log` for printing
&greet "hello,world!", SI::CAPABILITIES::WASIX::LOG

```

## Capability Wrappers

Passing ALL capabilities to ALL functions EVERY time is a bit painful.

We can use wrappers aka annotations that act as native High Order Functions.

```silicon
@@capability PRINT
@fn main message:string = {
  &print "message";
}
```

## Platforms

\*I'll likely move this to a separate file in the future

Platforms are sets of capabilities (APIs). Native platforms to Silicon will be 

- WASIX
- WEB (Browser APIs)
- NODE (NodeJS APIs)

In the future developers will be able to develop and publish their own Platforms