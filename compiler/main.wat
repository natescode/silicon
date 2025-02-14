
                (func $foo (export "foo")
                (param $index i32) (param $ value i32) 
                (result i32)
                    i32.const 1
                    return
                )
                
            
    ;; Loop from start to stop

    ;; initialize $index 
    (local $index i32)
    i32.const 0
    local.set $index

    ;; initialize value
    (local $value i32)
    local.get [semantics wrapper for Silicon]
    local.set $value

    ;; loop from start to stop
    (loop $loop

      ;; Call inline function with index & value as arguments
      (call $foo (local.get $index) (local.get $value))

      ;; Increment value
      local.get $value
      i32.const 1
      i32.add
      local.set $value

      ;; Increment index
      local.get $index
      i32.const 1
      i32.add
      local.set $index
      
      ;; Check if we are under $stop value
      local.get $value
      i32.const [semantics wrapper for Silicon]
      i32.le_u
      br_if $loop
    )
