/**
 * Silicon Web Environment Library
 *
 * Provides browser/JS API bindings as WASM imports for Silicon programs.
 * Feature-gated: only bindings for enabled platform features are included.
 *
 * Usage:
 *   const env = createWebEnv(opts, activeFeatures)
 *   // activeFeatures: array of enabled feature names, e.g. ['canvas', 'game', 'dom']
 *
 *   const { instance } = await WebAssembly.instantiate(bytes, env.imports)
 *   env.bindInstance(instance)
 *
 * Platform features:
 *   core   (always)  console_log*, math_*, performance_now, date_now
 *   canvas           canvas_set_fill, canvas_fill_rect, canvas_width, …
 *   dom              set_html, clear_html
 *   game             no imports — JS-side rAF loop (see startGameLoop)
 */

;(function (global) {
    'use strict'

    function createWebEnv(opts, activeFeatures) {
        opts = opts || {}
        activeFeatures = activeFeatures || []

        var onPrint = opts.onPrint || function (msg) { console.log('[web-env] ' + msg) }
        var onRenderNeeded = opts.onRenderNeeded || null

        var wasmMemory = null
        var wasmAlloc  = null

        // Silicon strings are UTF-8 with a 4-byte little-endian byte-length
        // header (see compiler std.wat / docs).  Read and write them as UTF-8.
        function readLenString(ptr) {
            if (!wasmMemory) return '[memory not bound]'
            var view = new DataView(wasmMemory.buffer)
            var byteLen = view.getInt32(ptr, true)
            var bytes = new Uint8Array(wasmMemory.buffer, ptr + 4, byteLen)
            try { return new TextDecoder('utf-8').decode(bytes) } catch (_) { return '[decode error]' }
        }

        function writeLenString(str) {
            if (!wasmMemory || !wasmAlloc) return 0
            var bytes = new TextEncoder().encode(str)   // UTF-8
            var ptr = wasmAlloc(4 + bytes.length)
            var view = new DataView(wasmMemory.buffer)
            view.setInt32(ptr, bytes.length, true)
            new Uint8Array(wasmMemory.buffer, ptr + 4, bytes.length).set(bytes)
            return ptr
        }

        var charBuf = []
        function flushCharBuf() {
            if (charBuf.length === 0) return
            onPrint(String.fromCharCode.apply(null, charBuf), 'print')
            charBuf = []
        }

        function getCanvasCtx() {
            var el = document.getElementById('render-canvas')
            if (!el) return null
            if (onRenderNeeded) onRenderNeeded()
            return el.getContext('2d')
        }

        // ── Core bindings (always included) ──────────────────────────────────
        var web = {
            console_log:     function (v)       { onPrint(String(v), 'print') },
            console_log_f:   function (v)       { onPrint(String(v), 'print') },
            console_log_str: function (ptr)     { onPrint(readLenString(ptr), 'print') },
            console_error:   function (v)       { console.error(v); onPrint('[error] ' + String(v), 'err') },
            console_warn:    function (v)       { console.warn(v);  onPrint('[warn] '  + String(v), 'warn') },
            console_info:    function (v)       { console.info(v);  onPrint('[info] '  + String(v), 'info') },

            math_random:     function ()        { return Math.random() },
            math_sin:        function (x)       { return Math.sin(x) },
            math_cos:        function (x)       { return Math.cos(x) },
            math_tan:        function (x)       { return Math.tan(x) },
            math_sqrt:       function (x)       { return Math.sqrt(x) },
            math_log:        function (x)       { return Math.log(x) },
            math_exp:        function (x)       { return Math.exp(x) },
            math_pow:        function (b, e)    { return Math.pow(b, e) },
            math_atan2:      function (y, x)    { return Math.atan2(y, x) },
            math_floor:      function (x)       { return Math.floor(x) },
            math_ceil:       function (x)       { return Math.ceil(x) },
            math_round:      function (x)       { return Math.round(x) },
            math_abs:        function (x)       { return Math.abs(x) },
            math_min:        function (a, b)    { return Math.min(a, b) },
            math_max:        function (a, b)    { return Math.max(a, b) },

            performance_now: function ()        { return performance.now() },
            date_now:        function ()        { return Date.now() },
        }

        // ── Canvas feature ────────────────────────────────────────────────────
        if (activeFeatures.indexOf('canvas') !== -1) {
            Object.assign(web, {
                canvas_set_fill:    function (r, g, b)       { var c = getCanvasCtx(); if (c) c.fillStyle   = 'rgb('+r+','+g+','+b+')' },
                canvas_set_stroke:  function (r, g, b)       { var c = getCanvasCtx(); if (c) c.strokeStyle = 'rgb('+r+','+g+','+b+')' },
                canvas_fill_rect:   function (x, y, w, h)    { var c = getCanvasCtx(); if (c) c.fillRect(x, y, w, h) },
                canvas_stroke_rect: function (x, y, w, h)    { var c = getCanvasCtx(); if (c) c.strokeRect(x, y, w, h) },
                canvas_clear_rect:  function (x, y, w, h)    { var c = getCanvasCtx(); if (c) c.clearRect(x, y, w, h) },
                canvas_fill_text:   function (ptr, x, y)     { var c = getCanvasCtx(); if (c) c.fillText(readLenString(ptr), x, y) },
                canvas_set_font:    function (ptr)            { var c = getCanvasCtx(); if (c) c.font = readLenString(ptr) },
                canvas_width:       function ()               { var el = document.getElementById('render-canvas'); return el ? el.width  : 320 },
                canvas_height:      function ()               { var el = document.getElementById('render-canvas'); return el ? el.height : 320 },
            })
        }

        // ── DOM feature ───────────────────────────────────────────────────────
        if (activeFeatures.indexOf('dom') !== -1) {
            Object.assign(web, {
                set_html:   function (ptr) {
                    var el = document.getElementById('html-out')
                    if (el) { el.innerHTML = readLenString(ptr); if (onRenderNeeded) onRenderNeeded() }
                },
                clear_html: function () {
                    var el = document.getElementById('html-out')
                    if (el) el.innerHTML = ''
                },
            })
        }

        // String↔JSString bridge: linear-memory `String` ⇄ JS string (externref).
        function allocLenString (s) {
            if (!wasmMemory || !wasmAlloc) return 0
            var bytes = new TextEncoder().encode(String(s == null ? '' : s))
            var ptr = wasmAlloc(4 + bytes.length)
            new DataView(wasmMemory.buffer).setInt32(ptr, bytes.length, true)
            new Uint8Array(wasmMemory.buffer, ptr + 4, bytes.length).set(bytes)
            return ptr
        }

        var imports = {
            env: {
                print: function (v) { if (v === 10) { flushCharBuf() } else { charBuf.push(v) } },
                read:  function ()  { return 0 },
            },
            web: web,
            // String↔JSString bridge (web/bun platform).
            'js-bridge': {
                fromString: function (ptr) { return readLenString(ptr) },
                toString:   function (s)   { return allocLenString(s) },
            },
            // Base `console` bindings — take a JSString (externref) directly.
            console: {
                log:   function (s) { onPrint(String(s == null ? '' : s), 'print') },
                error: function (s) { onPrint(String(s == null ? '' : s), 'error') },
            },
        }

        return {
            imports:      imports,
            bindInstance: function (instance) {
                if (instance && instance.exports && instance.exports.memory) wasmMemory = instance.exports.memory
                if (instance && instance.exports && instance.exports.alloc)  wasmAlloc  = instance.exports.alloc
            },
            flush:       flushCharBuf,
            readString:  readLenString,
            writeString: writeLenString,
        }
    }

    /**
     * Start the rAF game loop for the 'game' platform feature.
     * Calls instance.exports.tick() at ticksPerSecond (default 8), not every frame.
     * Returns a cancel function.
     */
    function startGameLoop(instance, onError, onFlush, ticksPerSecond) {
        var rafId = null
        var cancelled = false
        var msPerTick = 1000 / (ticksPerSecond || 8)
        var accumulated = 0
        var lastTime = null

        function loop(now) {
            if (cancelled) return
            if (lastTime === null) lastTime = now
            accumulated += now - lastTime
            lastTime = now
            // Cap accumulator to prevent spiral-of-death after tab switch
            if (accumulated > 250) accumulated = 250
            var ticked = false
            while (accumulated >= msPerTick) {
                accumulated -= msPerTick
                try {
                    instance.exports.tick()
                    ticked = true
                } catch (e) {
                    if (onError) onError(e)
                    return
                }
            }
            if (ticked && onFlush) onFlush()
            rafId = requestAnimationFrame(loop)
        }

        rafId = requestAnimationFrame(loop)

        return function cancel() {
            cancelled = true
            if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
        }
    }

    global.createWebEnv   = createWebEnv
    global.startGameLoop  = startGameLoop
})(typeof window !== 'undefined' ? window : globalThis)
