## Loops

Silicon has exactly one looping contruct, `@loop`

// TODO: copy from zzz_experimental
Silicol has one overloaded `@loop` construct. They are also expressions.

    // grammar
    Loop = "@loop" capture (seriesExpr | boolExpr)

### FOR with step

For loop with step 2 with range syntax

    // 1,3,5,7,9,11...
    @loop $1, 1..3..100, {
        #print i
    }

### WHILE

    @loop $1, i < 100, {
        i += 1
        #print i
    }

### DO WHILE

// new grammar with function?
@loop @fn i:mut = {
i += 1
#print i
@if i >= 100 $then @exit
}
