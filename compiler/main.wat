(module
    (func (export "main") (result i32)
        (local $age i32)
        (local.set $age i32.const 33)
        (local.get $age) 
        return
    )
)