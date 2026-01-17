;; Standard library for Sigil compiled to WebAssembly Text Format (WAT)
;; This module provides basic runtime support for Sigil programs, including memory management and I/O functions.

(module  ;; Start of the WebAssembly module definition
  (import "env" "print" (func $print (param i32)))  ;; Import a host function 'print' from the 'env' namespace that takes an i32 parameter (for printing integers)
  (import "env" "read" (func $read (result i32)))   ;; Import a host function 'read' from the 'env' namespace that returns an i32 (for reading input)
    (memory 1)  ;; Declare a linear memory with 1 page (64KB) for the module
    (global $heap (mut i32) (i32.const 1024))  ;; Declare a mutable global variable '$heap' initialized to 1024 (i32), used as a simple heap pointer for dynamic allocation
    ;; Function to allocate memory for arrays
    (func $alloc_array (param $size i32) (result i32)  ;; Define a function '$alloc_array' that takes a size parameter (i32) and returns an address (i32)
      (local $addr i32)  ;; Declare a local variable '$addr' of type i32 to store the allocated address
      (global.get $heap)  ;; Get the current value of the global '$heap' (push it onto the stack)
      (local.set $addr)   ;; Pop the stack value and set it to the local '$addr' (this is the start address for allocation)
      (global.get $heap)  ;; Get the current heap value again
      (local.get $size)   ;; Get the size parameter
      (i32.add)           ;; Add the size to the current heap value (calculate new heap position)
      (global.set $heap)  ;; Set the global '$heap' to the new position (advance the heap)
      (local.get $addr)   ;; Push the allocated address onto the stack (return value)
    )  ;; End of the function
    ;; for loops, conditionals, and other standard library functions can be added here
    (func $forloop (param $start i32) (param $end i32) (param $step i32) (param $body_addr i32)  ;; Define a function '$forloop' for iterating from start to end with a step
      ;; Implementation of the for loop logic goes here
      (local $i i32)
      (local.set $i $start)
      (loop $loop
        (if (i32.lt_u $i $end) then
          (block $body
            ;; Call the body function with current index
            (call $body_addr (local.get $i))
          )
          ;; Increment loop variable
          (local.set $i (i32.add $i $step))
          ;; Continue loop if condition is met
          (br_if $loop (i32.lt_u $i $end))
        )
      )
    )  ;; End of the function
    (func $ifelse (param $cond i32) (param $then_addr i32) (param $else_addr i32)  ;; Define a function '$ifelse' for conditional execution
      (if (i32.ne (local.get $cond) (i32.const 0)) then
        (call $then_addr)  ;; Call the 'then' branch if condition is true
      else
        (call $else_addr)  ;; Call the 'else' branch if condition is false
      )
    )  ;; End of the function
    
)  ;; End of the module