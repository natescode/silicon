;; Standard library for Sigil compiled to WebAssembly Text Format (WAT)
;; This module provides basic runtime support for Sigil programs, including memory management and I/O functions.

(module  ;; Start of the WebAssembly module definition
  (import "env" "print" (func $print (param i32)))  ;; Import a host function 'print' from the 'env' namespace that takes an i32 parameter (for printing integers)
  (import "env" "read" (func $read (result i32)))   ;; Import a host function 'read' from the 'env' namespace that returns an i32 (for reading input)
    (memory 1)  ;; Declare a linear memory with 1 page (64KB) for the module
    (global $heap (mut i32) (i32.const 1024))  ;; Declare a mutable global variable '$heap' initialized to 1024 (i32), used as a simple heap pointer for dynamic allocation
    ;; Function to allocate memory for arrays, with automatic memory growth
    (func $alloc_array (param $size i32) (result i32)  ;; Define a function '$alloc_array' that takes a size parameter (i32) and returns an address (i32) or -1 on failure
      (local $addr i32)        ;; Local to store the allocation address
      (local $new_heap i32)    ;; Local to calculate the new heap position
      (local $current_pages i32) ;; Local to store current memory size in pages
      (local $needed_pages i32)   ;; Local to calculate pages needed to grow
      (local $grow_result i32)    ;; Local to store result of memory.grow (-1 on failure)
      (global.get $heap)       ;; Get current heap pointer
      (local.get $size)        ;; Get requested size
      (i32.add)                ;; Calculate new heap position (heap + size)
      (local.set $new_heap)    ;; Store new heap position
      (memory.size)            ;; Get current memory size in pages
      (local.set $current_pages) ;; Store current pages
      (local.get $current_pages) ;; Push current pages
      (i32.const 16)           ;; 65536 bytes per page, shift left by 16 to multiply
      (i32.shl)                ;; current_pages * 65536 = current size in bytes
      (local.get $new_heap)    ;; Push new heap
      (i32.lt_s)               ;; Check if new_heap < current_size_bytes (enough space?)
      (if (result i32)         ;; If enough space, allocate normally
        (then
          (global.get $heap)   ;; Get current heap
          (local.set $addr)    ;; Set addr to current heap
          (local.get $new_heap) ;; Get new heap
          (global.set $heap)   ;; Advance heap to new position
          (local.get $addr)    ;; Return allocated address
        )
        (else                  ;; Not enough space, need to grow memory
          (local.get $new_heap) ;; Push new heap
          (local.get $current_pages) ;; Push current pages
          (i32.const 16)       ;; 65536
          (i32.shl)            ;; current_size_bytes
          (i32.sub)            ;; new_heap - current_size_bytes = bytes needed
          (i32.const 16)       ;; 65536
          (i32.shr_u)          ;; Divide by 65536 (integer division, floor)
          (i32.const 1)        ;; Add 1 for ceiling
          (i32.add)            ;; Ceil division: (bytes_needed + 65535) / 65536
          (local.set $needed_pages) ;; Store pages to grow
          (local.get $needed_pages) ;; Push pages to grow
          (memory.grow)        ;; Grow memory by needed_pages, returns previous size or -1
          (local.set $grow_result) ;; Store grow result
          (local.get $grow_result) ;; Push grow result
          (i32.const -1)       ;; -1 indicates failure
          (i32.eq)             ;; Check if grow failed
          (if                   ;; If grow failed, return -1 (allocation failure)
            (then
              (i32.const -1)   ;; Return -1 on failure
            )
            (else              ;; Grow succeeded, now allocate
              (global.get $heap) ;; Get current heap
              (local.set $addr)  ;; Set addr
              (local.get $new_heap) ;; Advance heap
              (global.set $heap)
              (local.get $addr)  ;; Return address
            )
          )
        )
      )
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