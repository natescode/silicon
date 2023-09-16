# One type to rule them all

Like `Ocaml` Silicon function do not have function overloading and can only return one type.

That said, function overloading _can_ still be done, more or less.

Example

```silicon
    @type order interface
        @fn compare:OrderEnum self, other
    @
```

## RUST

```Rust

// Define the trait for ordering
trait MyOrdering {
    fn compare(&self, other: &Self) -> std::cmp::Ordering;
}

// Implement the trait for the i32 type
impl MyOrdering for i32 {
    fn compare(&self, other: &Self) -> std::cmp::Ordering {
        self.cmp(other)
    }
}

// Implement the trait for the f64 type
impl MyOrdering for f64 {
    fn compare(&self, other: &Self) -> std::cmp::Ordering {
        self.partial_cmp(other).unwrap_or(std::cmp::Ordering::Equal)
    }
}

fn main() {
    let a = 5;
    let b = 10;
    println!("Comparing i32 values:");
    match a.compare(&b) {
        std::cmp::Ordering::Less => println!("{} < {}", a, b),
        std::cmp::Ordering::Equal => println!("{} == {}", a, b),
        std::cmp::Ordering::Greater => println!("{} > {}", a, b),
    }

    let x = 3.14;
    let y = 2.71;
    println!("Comparing f64 values:");
    match x.compare(&y) {
        std::cmp::Ordering::Less => println!("{} < {}", x, y),
        std::cmp::Ordering::Equal => println!("{} == {}", x, y),
        std::cmp::Ordering::Greater => println!("{} > {}", x, y),
    }
}
```

## The Paper

```Ocaml
1 module type Show = sig
2 type t
3 val show : t -> string
4 end
5
6 let show { S : Show } x = S . show x
7
8 implicit module Show_int = struct
9 type t = int
10 let show x = string_of_int x
11 end
12
13 implicit module Show_float = struct
14 type t = float
15 let show x = string_of_float x
16 end
17
18 implicit module Show_list { S : Show } = struct
19 type t = S . t list
20 let show x = string_of_list S . show x
21 end
22
23 let () =
24 print_endline (" Show an int: " ^ show 5);
25 print_endline (" Show a float : " ^ show 1.5);
26 print_endline (" Show a list of ints : " ^ show [1; 2; 3]);
```

### Silicon version

```silicon
@trait Show 'T = {
    @fn show:string T
}

@fn show x:Show = {
    x.show
}

@impl Show @for bool = {
    @fn show:string x:bool = {
        @if x
        @then "true"
        @else "false"
    }
}
```

Possibly use decorator syntax like `Java` or `C#` _attributes_.

```silicon
@@impl Show
@fn show x = {
    @if x
    @then "true"
    @else "false"
}
```
