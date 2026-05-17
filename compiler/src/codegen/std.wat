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
(export "memory" (memory 0))
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
(export "alloc" (func $alloc))

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
;; $scratch_alloc — bump-allocate `$n` bytes of writable scratch space
;; and return its base address. Equivalent to `$alloc $n` with the
;; intent annotated: the buffer is meant to be passed to an extern
;; declared with an out-pointer (the host writes into it).
;;
;; Full out-pointer convention is documented in docs/extern-out-pointer.md.
;; Lifetime: scratch addresses live until the next arena_reset
;; (currently a no-op — Stage 0 leaks at end-of-compile). Stage 1's
;; arena reset will reclaim them between compile passes.
;; ------------------------------------------------------------------
(func $scratch_alloc (param $n i32) (result i32)
  (call $alloc (local.get $n)))
(export "scratch_alloc" (func $scratch_alloc))

;; ------------------------------------------------------------------
;; $str_ptr / $str_len — String → Int bridges.
;; Strings are length-prefixed UTF-8 buffers; the typechecker treats
;; them as a distinct type but at the WASM level they're just i32
;; pointers.  $str_ptr is identity (returns the supplied pointer);
;; $str_len reads the 4-byte length header at offset 0.
;; ------------------------------------------------------------------
(func $str_ptr (param $s i32) (result i32)
  (local.get $s))

(func $str_len (param $s i32) (result i32)
  (i32.load (local.get $s)))

;; ------------------------------------------------------------------
;; $heap_get / $heap_set — read and rewrite the bump pointer.
;; The arena reset pattern (cleanup-plan §3, bootstrap §Phase 0) is
;;   base := heap_get
;;   ... do work that allocates ...
;;   heap_set base   ;; everything allocated after the save is dropped
;; Use with care: addresses returned after the save become invalid once
;; the reset is performed.
;; ------------------------------------------------------------------
(func $heap_get (result i32)
  (global.get $heap))

(func $heap_set (param $h i32)
  (global.set $heap (local.get $h)))

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
;; $arr_store_i32 — write an i32 value to the Nth element of a prefixed array.
;;   offset = ptr + 4 + (index * 4)
;; ------------------------------------------------------------------
(func $arr_store_i32 (param $ptr i32) (param $index i32) (param $value i32)
  (i32.store
    (i32.add
      (local.get $ptr)
      (i32.add (i32.const 4) (i32.mul (local.get $index) (i32.const 4))))
    (local.get $value)))

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

;; ------------------------------------------------------------------
;; $str_concat — concatenate two Silicon UTF-8 strings.
;; Both $a and $b are i32 pointers to length-prefixed buffers.
;; Returns a new heap-allocated string containing $a followed by $b.
;; ------------------------------------------------------------------
(func $str_concat (param $a i32) (param $b i32) (result i32)
  (local $len_a i32)
  (local $len_b i32)
  (local $total i32)
  (local $dst   i32)
  (local $i     i32)

  (local.set $len_a (i32.load (local.get $a)))
  (local.set $len_b (i32.load (local.get $b)))
  (local.set $total (i32.add (local.get $len_a) (local.get $len_b)))

  ;; allocate 4-byte header + combined payload
  (local.set $dst
    (call $alloc (i32.add (i32.const 4) (local.get $total))))

  ;; write combined byte-length header
  (i32.store (local.get $dst) (local.get $total))

  ;; copy payload of $a byte by byte into dst+4
  (local.set $i (i32.const 0))
  (block $brk_a
    (loop $cp_a
      (br_if $brk_a (i32.ge_s (local.get $i) (local.get $len_a)))
      (i32.store8
        (i32.add (i32.add (local.get $dst) (i32.const 4)) (local.get $i))
        (i32.load8_u
          (i32.add (i32.add (local.get $a) (i32.const 4)) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cp_a)))

  ;; copy payload of $b byte by byte into dst+4+len_a
  (local.set $i (i32.const 0))
  (block $brk_b
    (loop $cp_b
      (br_if $brk_b (i32.ge_s (local.get $i) (local.get $len_b)))
      (i32.store8
        (i32.add
          (i32.add (local.get $dst) (i32.add (i32.const 4) (local.get $len_a)))
          (local.get $i))
        (i32.load8_u
          (i32.add (i32.add (local.get $b) (i32.const 4)) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cp_b)))

  (local.get $dst))
