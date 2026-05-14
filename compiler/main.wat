(module
;; Silicon Standard Library
;; -------------------------------------------------------------------------
;; Helper functions that compiled Silicon programs can call. This file is
;; embedded verbatim (without the surrounding `(module ...)`) into every
;; emitted module by `compile.ts`.
;;
;; Runtime imports (supplied by the WASM embedder):
;;   env.print      (param i32)          — print a single i32 (also used for
;;                                          chars; host decides how to render)
;;   env.read       (result i32)         — read a single i32 from input
;;
;; Heap layout
;;   A mutable i32 global `$heap` holds the next free address. `$alloc`
;;   bumps it, growing linear memory if needed.
;;
;; Length-prefixed blocks
;;   Arrays and strings share a layout: the first i32 at the returned address
;;   is the length (element count for arrays, byte count for strings); the
;;   payload follows immediately.
;;
;;       +--------+--------+------+------+------+
;;       | length | elem0  | elem1| ...  | elemN|
;;       +--------+--------+------+------+------+
;;        0       4        8                    4+N*elem_size
;;
;;   Strings use byte-sized elements. Arrays of Int/Float/Bool/pointer all
;;   use 4-byte elements (matching i32/f32 in WASM).
;; -------------------------------------------------------------------------

(import "env" "print" (func $print (param i32)))
(import "env" "read"  (func $read  (result i32)))

(memory 1)
(global $heap (mut i32) (i32.const 1024))

;; ------------------------------------------------------------------
;; $alloc — bump-allocate `$size` bytes from the heap, growing memory
;; by whole pages if the request won't fit. Returns the starting
;; address on success, -1 on memory.grow failure.
;; ------------------------------------------------------------------
(func $alloc (param $size i32) (result i32)
  (local $addr i32)
  (local $new_heap i32)
  (local $cur_bytes i32)
  (local $need_pages i32)

  ;; new_heap = heap + size
  (local.set $new_heap
    (i32.add (global.get $heap) (local.get $size)))

  ;; cur_bytes = memory.size * 65536
  (local.set $cur_bytes
    (i32.shl (memory.size) (i32.const 16)))

  ;; If new_heap <= cur_bytes, we can allocate without growing.
  (if (i32.le_s (local.get $new_heap) (local.get $cur_bytes))
    (then
      (local.set $addr (global.get $heap))
      (global.set $heap (local.get $new_heap))
      (return (local.get $addr))))

  ;; Need to grow. Pages = ceil((new_heap - cur_bytes) / 65536).
  (local.set $need_pages
    (i32.add
      (i32.shr_u
        (i32.sub (local.get $new_heap) (local.get $cur_bytes))
        (i32.const 16))
      (i32.const 1)))

  ;; memory.grow returns -1 on failure, else the previous page count.
  (if (i32.eq (memory.grow (local.get $need_pages)) (i32.const -1))
    (then (return (i32.const -1))))

  (local.set $addr (global.get $heap))
  (global.set $heap (local.get $new_heap))
  (local.get $addr))

;; ------------------------------------------------------------------
;; $alloc_array — allocate a length-prefixed region holding `$count`
;; elements of `$elem_bytes` bytes each. Stores `$count` at offset 0.
;; Returns the base address; element 0 starts at (base + 4).
;;
;; Layout: [length:i32][elem0][elem1]...[elemN-1]
;; ------------------------------------------------------------------
(func $alloc_array (param $count i32) (param $elem_bytes i32) (result i32)
  (local $base i32)
  (local.set $base
    (call $alloc
      (i32.add
        (i32.const 4)
        (i32.mul (local.get $count) (local.get $elem_bytes)))))
  (i32.store (local.get $base) (local.get $count))
  (local.get $base))

;; ------------------------------------------------------------------
;; $alloc_string — allocate a length-prefixed byte buffer for a string
;; of `$byte_len` bytes. First i32 holds the byte length; the payload
;; starts at (base + 4).
;;
;; Silicon strings are stored as UTF-8 byte sequences. Callers are
;; responsible for writing the bytes into memory at the returned
;; address + 4.
;; ------------------------------------------------------------------
(func $alloc_string (param $byte_len i32) (result i32)
  (local $base i32)
  (local.set $base
    (call $alloc
      (i32.add (i32.const 4) (local.get $byte_len))))
  (i32.store (local.get $base) (local.get $byte_len))
  (local.get $base))

;; ------------------------------------------------------------------
;; $arr_len — read the length stored in a prefixed array/string.
;; ------------------------------------------------------------------
(func $arr_len (param $ptr i32) (result i32)
  (i32.load (local.get $ptr)))

;; ------------------------------------------------------------------
;; $arr_load_i32 — read the Nth i32 element of a prefixed i32 array.
;;   offset = ptr + 4 + (index * 4)
;; ------------------------------------------------------------------
(func $arr_load_i32 (param $ptr i32) (param $index i32) (result i32)
  (i32.load
    (i32.add
      (local.get $ptr)
      (i32.add (i32.const 4) (i32.mul (local.get $index) (i32.const 4))))))

;; ------------------------------------------------------------------
;; $arr_load_f32 — read the Nth f32 element of a prefixed f32 array.
;; ------------------------------------------------------------------
(func $arr_load_f32 (param $ptr i32) (param $index i32) (result f32)
  (f32.load
    (i32.add
      (local.get $ptr)
      (i32.add (i32.const 4) (i32.mul (local.get $index) (i32.const 4))))))

;; ------------------------------------------------------------------
;; Print helpers — thin wrappers around the host `print(i32)` import.
;; Floats are converted via truncation for this POC; a richer host
;; print interface can replace these once we expose one.
;; ------------------------------------------------------------------
(func $print_int (param $v i32)
  (call $print (local.get $v)))

(func $print_bool (param $v i32)
  (call $print (local.get $v)))

(func $print_float (param $v f32)
  (call $print (i32.trunc_f32_s (local.get $v))))

;; ------------------------------------------------------------------
;; $print_string — print each byte of a length-prefixed string by
;; calling the host print function once per byte. Hosts can treat
;; the i32 as a char code.
;; ------------------------------------------------------------------
(func $print_string (param $ptr i32)
  (local $len i32)
  (local $i i32)
  (local.set $len (i32.load (local.get $ptr)))
  (local.set $i (i32.const 0))
  (block $done
    (loop $next
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (call $print
        (i32.load8_u
          (i32.add
            (local.get $ptr)
            (i32.add (i32.const 4) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next))))

(global $Color_Red i32 (i32.const 0))
(global $Color_Green i32 (i32.const 1))
(global $Color_Blue i32 (i32.const 2))
(global $Status_Ok i32 (i32.const 0))
(global $Status_Warn i32 (i32.const 1))
(global $Status_Error i32 (i32.const 2))
(func $add (param $a i32) (param $b i32) (result i32)
(local $addr i32)
(i32.add (local.get $a) (local.get $b))
)
(export "add" (func $add))
(func $safeDivide (param $x i32) (param $y i32) (result i32)
(local $addr i32)
(if
  (i32.eq (local.get $y) (i32.const 0))
  (then (return (i32.const 0)))
)
(i32.div_s (local.get $x) (local.get $y))
)
(export "safeDivide" (func $safeDivide))
(func $countDown (param $n i32) (result i32)
(local $addr i32)
(local $i i32)
(local.set $i (local.get $n))
(block $brk_0
  (loop $cont_0
    (br_if $brk_0 (i32.eqz (i32.gt_s (local.get $i) (i32.const 0))))
    (local.set $i (i32.sub (local.get $i) (i32.const 1)))
    (br $cont_0)
  )
)
(local.get $i)
)
(export "countDown" (func $countDown))
(func $colorCode (param $c i32) (result i32)
(local $addr i32)
(if (result i32)
  (i32.eq (local.get $c) (global.get $Color_Red))
  (then (i32.const 1))
  (else (if (result i32)
  (i32.eq (local.get $c) (global.get $Color_Green))
  (then (i32.const 2))
  (else (i32.const 0))
))
)
)
(export "colorCode" (func $colorCode))
(func $statusPriority (param $s i32) (result i32)
(local $addr i32)
(if (result i32)
  (i32.eq (local.get $s) (global.get $Status_Error))
  (then (i32.const 2))
  (else (if (result i32)
  (i32.eq (local.get $s) (global.get $Status_Warn))
  (then (i32.const 1))
  (else (i32.const 0))
))
)
)
(export "statusPriority" (func $statusPriority))
(func $circleArea (param $r f32) (result f32)
(local $addr i32)
(f32.mul (local.get $r) (local.get $r))
)
(export "circleArea" (func $circleArea))
(export "add" (func $add))
(export "safeDivide" (func $safeDivide))
(export "countDown" (func $countDown))
(export "colorCode" (func $colorCode))
(export "statusPriority" (func $statusPriority))
(export "circleArea" (func $circleArea))
)