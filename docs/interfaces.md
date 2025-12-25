# Interfaces

Silicon has interfaces much like many languages.

Interfaces define the expected operation that can be performed on a type.

```silicon
@interface mover T = {
    @fn move_up T, amount:int;
    @fn move_down T, amount:int;
    @fn move_left T, amount:int;
    @fn move_right T, amount:int;
};
```

Silicon has two ways types can conform to an interface: implicit and explicit.

If functions with the same names already exist then they implicitly conform by `structure`. 
If functions with the same names in the annotations then they explicitly conform by `semantic naming`.
If a type explicitly declares that it `@conforms` to an interfaces then it does so by `nominal typing`.


```silicon
# implicitly conforms to 'mover' via structure
@type car = {
    @fn move_up T, amount:int;
    @fn move_down T, amount:int;
    @fn move_left T, amount:int;
    @fn move_right T, amount:int;
};

# explicitly conforms to 'mover' via semantics
@type car = {
    @@semantic mover::move_up
    @fn gas T, amount:int;

    @@semantic mover::move_down
    @fn brake T, amount:int;

    @@semantic mover::move_left
    @fn turn_left T, amount:int;

    @@semantic mover::move_right
    @fn turn_right T, amount:int;
};

@@conforms $to mover;
@type car = {
    @fn move_up T, amount:int;
    @fn move_down T, amount:int;
    @fn move_left T, amount:int;
    @fn move_right T, amount:int;
};
```
