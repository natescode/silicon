/**
 * Silicon Web Environment Library
 *
 * Provides browser/JS API bindings as WASM imports for Silicon programs.
 * Fulfils the built-in "web" module — declared in src/strata/modules/web.si
 * and auto-resolved by the compiler when Silicon code calls &web::*.
 *
 * Usage:
 *   const env = createWebEnv({ onPrint: (msg, type) => ... })
 *   const { instance } = await WebAssembly.instantiate(bytes, env.imports)
 *   env.bindInstance(instance)   // wire memory for string reads
 *
 * Available via the web:: module namespace (no @extern needed in Silicon source):
 *
 *   Console
 *     &web::console_log   v:Int          -- print integer
 *     &web::console_log_f v:Float        -- print float
 *     &web::console_log_str ptr:String   -- print length-prefixed string
 *     &web::console_error v:Int          -- console.error integer
 *     &web::console_warn  v:Int          -- console.warn integer
 *     &web::console_info  v:Int          -- console.info integer
 *
 *   Math  (all f32 → f32 unless noted)
 *     &web::math_random:Float            -- 0.0–1.0
 *     &web::math_sin   x:Float
 *     &web::math_cos   x:Float
 *     &web::math_tan   x:Float
 *     &web::math_sqrt  x:Float
 *     &web::math_log   x:Float           -- natural log
 *     &web::math_exp   x:Float
 *     &web::math_pow   base:Float, exp:Float
 *     &web::math_atan2 y:Float, x:Float
 *     &web::math_floor x:Float
 *     &web::math_ceil  x:Float
 *     &web::math_round x:Float
 *     &web::math_abs   x:Float
 *     &web::math_min   a:Float, b:Float
 *     &web::math_max   a:Float, b:Float
 *
 *   Time  (returns f32 milliseconds)
 *     &web::performance_now:Float        -- high-res timer (ms)
 *     &web::date_now:Float               -- ms since Unix epoch
 */

;(function (global) {
    'use strict'

    function createWebEnv(opts) {
        opts = opts || {}
        var onPrint = opts.onPrint || function (msg, type) {
            console.log('[web-env] ' + msg)
        }
        var onRenderNeeded = opts.onRenderNeeded || null

        // Memory and allocator are wired after WASM instantiation via bindInstance().
        var wasmMemory = null
        var wasmAlloc  = null

        // Read a Silicon length-prefixed string from WASM linear memory.
        // Layout: [i32 byte_len][utf16le bytes...]
        // Silicon encodes strings as UTF-16 LE so JS can use them natively.
        function readLenString(ptr) {
            if (!wasmMemory) return '[memory not bound]'
            var view = new DataView(wasmMemory.buffer)
            var byteLen = view.getInt32(ptr, true)
            var bytes = new Uint8Array(wasmMemory.buffer, ptr + 4, byteLen)
            try {
                return new TextDecoder('utf-16le').decode(bytes)
            } catch (_) {
                return '[decode error]'
            }
        }

        // Write a JS string into Silicon's heap as a length-prefixed UTF-16 LE buffer.
        // Returns the i32 pointer. Requires bindInstance() to have been called first.
        function writeLenString(str) {
            if (!wasmMemory || !wasmAlloc) return 0
            var byteLen = str.length * 2                     // 2 bytes per UTF-16 code unit
            var ptr = wasmAlloc(4 + byteLen)                 // allocate from Silicon heap
            var view = new DataView(wasmMemory.buffer)
            view.setInt32(ptr, byteLen, true)                // length prefix (little-endian)
            for (var i = 0; i < str.length; i++) {
                view.setUint16(ptr + 4 + i * 2, str.charCodeAt(i), true)
            }
            return ptr
        }

        // Accumulate env.print char-by-char into lines (Silicon's $print_string
        // calls env.print once per byte, newline = 10).
        var charBuf = []
        function flushCharBuf() {
            if (charBuf.length === 0) return
            onPrint(String.fromCharCode.apply(null, charBuf), 'print')
            charBuf = []
        }

        var imports = {
            // ── env namespace (Silicon runtime) ──────────────────────────────
            env: {
                print: function (v) {
                    if (v === 10) {
                        flushCharBuf()
                    } else {
                        charBuf.push(v)
                    }
                },
                read: function () { return 0 },
            },

            // ── web namespace ─────────────────────────────────────────────────
            web: {
                // Console — integer
                console_log: function (v) { onPrint(String(v), 'print') },
                // Console — float
                console_log_f: function (v) { onPrint(String(v), 'print') },
                // Console — length-prefixed string pointer
                console_log_str: function (ptr) { onPrint(readLenString(ptr), 'print') },
                // Severity variants (all take i32)
                console_error: function (v) {
                    console.error(v)
                    onPrint('[error] ' + String(v), 'err')
                },
                console_warn: function (v) {
                    console.warn(v)
                    onPrint('[warn] ' + String(v), 'warn')
                },
                console_info: function (v) {
                    console.info(v)
                    onPrint('[info] ' + String(v), 'info')
                },

                // Math — all take/return f32; JS coercion is transparent
                math_random: function () { return Math.random() },
                math_sin:    function (x) { return Math.sin(x) },
                math_cos:    function (x) { return Math.cos(x) },
                math_tan:    function (x) { return Math.tan(x) },
                math_sqrt:   function (x) { return Math.sqrt(x) },
                math_log:    function (x) { return Math.log(x) },
                math_exp:    function (x) { return Math.exp(x) },
                math_pow:    function (b, e) { return Math.pow(b, e) },
                math_atan2:  function (y, x) { return Math.atan2(y, x) },
                math_floor:  function (x) { return Math.floor(x) },
                math_ceil:   function (x) { return Math.ceil(x) },
                math_round:  function (x) { return Math.round(x) },
                math_abs:    function (x) { return Math.abs(x) },
                math_min:    function (a, b) { return Math.min(a, b) },
                math_max:    function (a, b) { return Math.max(a, b) },

                // Time
                performance_now: function () { return performance.now() },
                date_now:        function () { return Date.now() },

                // Canvas drawing
                canvas_set_fill: function (r, g, b) {
                    var ctx = getCanvasCtx()
                    if (ctx) ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')'
                },
                canvas_set_stroke: function (r, g, b) {
                    var ctx = getCanvasCtx()
                    if (ctx) ctx.strokeStyle = 'rgb(' + r + ',' + g + ',' + b + ')'
                },
                canvas_fill_rect: function (x, y, w, h) {
                    var ctx = getCanvasCtx()
                    if (ctx) ctx.fillRect(x, y, w, h)
                },
                canvas_stroke_rect: function (x, y, w, h) {
                    var ctx = getCanvasCtx()
                    if (ctx) ctx.strokeRect(x, y, w, h)
                },
                canvas_clear_rect: function (x, y, w, h) {
                    var ctx = getCanvasCtx()
                    if (ctx) ctx.clearRect(x, y, w, h)
                },
                canvas_fill_text: function (ptr, x, y) {
                    var ctx = getCanvasCtx()
                    if (ctx) ctx.fillText(readLenString(ptr), x, y)
                },
                canvas_set_font: function (ptr) {
                    var ctx = getCanvasCtx()
                    if (ctx) ctx.font = readLenString(ptr)
                },
                canvas_width: function () {
                    var el = document.getElementById('render-canvas')
                    return el ? el.width : 320
                },
                canvas_height: function () {
                    var el = document.getElementById('render-canvas')
                    return el ? el.height : 320
                },

                // HTML output
                set_html: function (ptr) {
                    var el = document.getElementById('html-out')
                    if (el) {
                        el.innerHTML = readLenString(ptr)
                        if (onRenderNeeded) onRenderNeeded()
                    }
                },
                clear_html: function () {
                    var el = document.getElementById('html-out')
                    if (el) el.innerHTML = ''
                },
            },
        }

        function getCanvasCtx() {
            var el = document.getElementById('render-canvas')
            if (!el) return null
            if (onRenderNeeded) onRenderNeeded()
            return el.getContext('2d')
        }

        return {
            imports: imports,
            /** Call after WebAssembly.instantiate to enable string reads/writes. */
            bindInstance: function (instance) {
                if (instance && instance.exports && instance.exports.memory) {
                    wasmMemory = instance.exports.memory
                }
                if (instance && instance.exports && instance.exports.alloc) {
                    wasmAlloc = instance.exports.alloc
                }
            },
            /** Flush any pending char output (e.g. after a WASM call returns). */
            flush: flushCharBuf,
            /** Read a Silicon length-prefixed UTF-16 LE string from WASM memory. */
            readString: readLenString,
            /** Write a JS string into Silicon's heap. Returns the i32 pointer. */
            writeString: writeLenString,
        }
    }

    global.createWebEnv = createWebEnv
})(typeof window !== 'undefined' ? window : globalThis)
