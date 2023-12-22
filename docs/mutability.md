# Mutability

Silicon is immutable by default. It even has immutable data-structures, [tail call optimization]() etc.

I have yet to show how to make anything mutable in Silicon. There is a built in Annotation for mutability.

    @name age = 32;
    age += 1; //error 'age' is immutable

If we really need to mutate then

    @name age:mut = 32;

Technically the full type is `:mut:int` for mutable integer

    @name age:mut:int = 32;
