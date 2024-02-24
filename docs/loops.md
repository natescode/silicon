## Loops

Silicon has exactly one looping contruct, `@loop`

// TODO: copy from zzz_experimental
Silicol has one overloaded `@loop` construct. They are also expressions.

    // grammar
    Loop = "@loop" (condition | iterable), function

### FOR with step

For loop with step 2 with range syntax

#### Function

    // 1,3,5,7,9,11...
    @loop 1..3..100, @func _ i = {
        #print i;
    };

#### Lambda

    // 1,3,5,7,9,11...
    @loop 1..3..100, \\i => {
        #print i;
    };

### For Each

#### Function

    @loop students, @fn _ student = {
        #print i;
    };

#### Lambda

    @loop students, \\student => #print i;

### WHILE

#### Function

    @loop i < 100, @func _ i = {
        i += 1;
        #print i;
    };

#### Lambda

    @loop i < 100, \\i = {
        i += 1;
        #print i;
    };

### DO WHILE

// new grammar with function?

    @loop _, @fn i:mut = {
        i += 1;
        #print i;
        @if i >= 100 $then @exit;
    };
