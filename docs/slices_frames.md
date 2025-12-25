# Slices and Frames

I've had this idea for years now. Most are familiar with slices or subarrays in other languages. Silicon is no different.

Silicon does differentiate between two different types of subarrays: slices and frames.

*2025-Aug-17* Replace `@@slice` and `@@frame` with just `@mut` and `@imm` ?


## Slice

A slice is like a slice of pizza, everyone get their own slice that they don't share and they consume it (mutate it).

Slices are unique and mutable.

```silicon
@let numbers = [86,70,90,20,50,31,77,29];
@let slice_1 = @@slice numbers, [0..3] // 86, 70
@let slice_2 = @@slice numbers, [3..5] // 20, 50
slice_2[0] = 21 // 20 is now 21
@let slice_3 = @@slice numbers, [4..9] // Error! Slice is not unique!
```

## Frame

Frames are like pictures in frames at the museum. Everyone can look at the same ones but no one can touch them.
Frames are the implicit with the range syntax. The explicity `@@frame` comptime function can be used as well.

Frames are immutable (read-only). They do not require unique ranges.

```silicon
@let numbers = [86,70,90,20,50,31,77,29];
@let slice_1 = numbers[0..3] // 86, 70
@let slice_2 = numbers[3..5] // 20, 50
slice_2[0] = 21 // 20 is now 21
@let slice_3 = numbers[4..9] // Error! Slice is not unique!
```