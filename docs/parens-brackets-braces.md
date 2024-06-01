## Parens, Braces and Brackets

| Bracket | Description                                        |
| --- | ------------------------------------------------------ |
| [ ] | encloses type parameters or type arguments             |
| ( ) | groups expressions, parameter/arugment lists or tuples |
| { } | sequence of statements or definitions                  |


## Thougths and Examples

I thought that `{}` for a list of expressions for a function body would be confused with a list of key value pairs for a dictionary / map.

BUT the following code could be a valid `block` that is the body of a function or a valid `map` literal.

```silicon
{
	name:string = "Nate";
    age:int = 33
};
```


What if we added _"extra"_ stuff to it?

```silicon
{
	name:string = "Nate";
    age:int = 33;

    &print "Hi, I'm {name} and I am {age} years old"
    
};
```

Is that still a valid `map`? In a statically typed language, probaly not. In a dynamically typed language where _EVERYTHING_ is an object, then possibly.


## Map literal


`[name:type=value,name2:type2=value2]`