// SPDX-License-Identifier: MIT
/**
 * Bun/JS host runner for the web/bun platform.
 *
 * `sgl run --platform=bun` executes a compiled module in-process under Bun's
 * `WebAssembly` (wasmtime can't provide the WASM JS String Builtins).  The
 * module is compiled with `{ builtins: ['js-string'] }` so `wasm:js-string`
 * imports resolve to the host's native JS-string operations, and a small import
 * object provides `env.print/read`, a String↔JSString bridge, and a base
 * Browser/Bun API surface (console, …).  The program's `_start` export (its
 * top-level statements) is then invoked.
 */

interface HostState { memory?: WebAssembly.Memory; alloc?: (n: number) => number }

/** Build the import object + a binder that captures the instance's memory/alloc. */
function buildImports(state: HostState, write: (s: string) => void) {
    // `env.print` receives one byte (or char code) at a time — accumulate and
    // flush on newline, matching the linear-memory `$print_string` convention.
    const buf: number[] = []
    const flush = () => { if (buf.length) { write(Buffer.from(buf).toString('utf-8')); buf.length = 0 } }

    // Next FFI work #2 — the boundary error channel.  A fallible `js` invoker
    // (call/apply/construct) or an awaited Promise rejection (captured in
    // runUnderBun) records the thrown host value here instead of trapping; guest
    // code reads it via `js::had_error()` / `js::error_message()` and lifts it
    // into a Silicon `Result` (stdlib `ffi.si`).  `pins` threads a JSValue
    // through a linear-memory Result by id (externref can't live in a record).
    const errBox: { last: any } = { last: null }
    const pins: any[] = [null]   // index 0 reserved = "no handle"

    /** Read a Silicon linear-memory string (4-byte LE length + UTF-8) → JS string. */
    const readLenString = (ptr: number): string => {
        if (!state.memory) return ''
        const view = new DataView(state.memory.buffer)
        const len = view.getInt32(ptr, true)
        return new TextDecoder('utf-8').decode(new Uint8Array(state.memory.buffer, ptr + 4, len))
    }
    /** Encode a JS string into a fresh linear-memory string, returning its ptr. */
    const allocLenString = (s: string): number => {
        if (!state.memory || !state.alloc) return 0
        const bytes = new TextEncoder().encode(s)
        const ptr = state.alloc(4 + bytes.length)
        const view = new DataView(state.memory.buffer)
        view.setInt32(ptr, bytes.length, true)
        new Uint8Array(state.memory.buffer, ptr + 4, bytes.length).set(bytes)
        return ptr
    }

    const imports: WebAssembly.Imports = {
        env: {
            print: (v: number) => { if (v === 10) flush(); else buf.push(v) },
            read: () => 0,
        },
        // String↔JSString bridge: linear `String` ⇄ JS string (externref).
        'js-bridge': {
            fromString: (ptr: number) => readLenString(ptr),
            toString: (s: string) => allocLenString(s),
        },
        // Base Browser/Bun API surface — externref-typed; users extend via @extern.
        console: {
            log: (s: unknown) => { flush(); write(String(s ?? '') + '\n') },
            error: (s: unknown) => { flush(); process.stderr.write(String(s ?? '') + '\n') },
        },
        // The `web` module (web.si): console + portable Math.  Canvas/DOM are
        // browser-only and intentionally absent — a program that imports them
        // won't instantiate under the headless bun runner.
        web: {
            console_log: (v: number) => { flush(); write(String(v) + '\n') },
            console_log_f: (v: number) => { flush(); write(String(v) + '\n') },
            console_log_str: (ptr: number) => { flush(); write(readLenString(ptr) + '\n') },
            console_error: (v: number) => { flush(); process.stderr.write(String(v) + '\n') },
            console_warn: (v: number) => { flush(); write('[warn] ' + v + '\n') },
            console_info: (v: number) => { flush(); write('[info] ' + v + '\n') },
            // === bindgen:web math+clock (generated — edit compiler/bindgen/src/spec.ts, run `bun bindgen/cli.ts --write`) ===
            math_random: Math.random,
            math_sin: Math.sin,
            math_cos: Math.cos,
            math_tan: Math.tan,
            math_sqrt: Math.sqrt,
            math_log: Math.log,
            math_exp: Math.exp,
            math_pow: Math.pow,
            math_atan2: Math.atan2,
            math_floor: Math.floor,
            math_ceil: Math.ceil,
            math_round: Math.round,
            math_abs: Math.abs,
            math_min: Math.min,
            math_max: Math.max,

            performance_now: () => performance.now(),
            date_now: () => Date.now(),
            // === /bindgen:web math+clock ===
        },
        // Generated built-in modules (compiler/bindgen) — Node + Bun surfaces,
        // string-marshalled via readLenString/allocLenString.  Callable from
        // Silicon as `path::basename(…)` / `bun::nanoseconds()`.
        path: {
            // === bindgen:module path ===
            basename: (path: number, suffix: number) => allocLenString(require('node:path').basename(readLenString(path), readLenString(suffix))),
            dirname: (path: number) => allocLenString(require('node:path').dirname(readLenString(path))),
            extname: (path: number) => allocLenString(require('node:path').extname(readLenString(path))),
            is_absolute: (path: number) => require('node:path').isAbsolute(readLenString(path)),
            matches_glob: (path: number, pattern: number) => require('node:path').matchesGlob(readLenString(path), readLenString(pattern)),
            normalize: (path: number) => allocLenString(require('node:path').normalize(readLenString(path))),
            relative: (from: number, to: number) => allocLenString(require('node:path').relative(readLenString(from), readLenString(to))),
            to_namespaced_path: (path: number) => allocLenString(require('node:path').toNamespacedPath(readLenString(path))),
            // === /bindgen:module path ===
        },
        os: {
            // === bindgen:module os ===
            arch: () => allocLenString(require('node:os').arch()),
            available_parallelism: () => require('node:os').availableParallelism(),
            endianness: () => allocLenString(require('node:os').endianness()),
            freemem: () => require('node:os').freemem(),
            get_priority: (pid: number) => require('node:os').getPriority(pid),
            homedir: () => allocLenString(require('node:os').homedir()),
            hostname: () => allocLenString(require('node:os').hostname()),
            machine: () => allocLenString(require('node:os').machine()),
            platform: () => allocLenString(require('node:os').platform()),
            release: () => allocLenString(require('node:os').release()),
            set_priority: (priority: number) => require('node:os').setPriority(priority),
            tmpdir: () => allocLenString(require('node:os').tmpdir()),
            totalmem: () => require('node:os').totalmem(),
            type: () => allocLenString(require('node:os').type()),
            uptime: () => require('node:os').uptime(),
            version: () => allocLenString(require('node:os').version()),
            // === /bindgen:module os ===
        },
        // JSON (Tier-2): `parse`/`stringify` pass a host object across as an
        // externref `JSValue` — no marshalling, engine-GC'd.
        json: {
            // === bindgen:module json ===
            parse: (text: any) => JSON.parse(text),
            stringify: (value: any) => JSON.stringify(value),
            // === /bindgen:module json ===
        },
        // `js` (Tier-2): the generic object/array build-and-read substrate for
        // JSValue handles (hand-authored — see compiler/src/strata/modules/js.si).
        // Build options bags to pass IN; inspect handles handed back OUT.  Box/
        // unbox Silicon scalars via from_*/as_*.  All values cross as externref.
        js: {
            object: () => ({}),
            array: () => [],
            null: () => null,
            undefined: () => undefined,
            set: (o: any, k: any, v: any) => { o[k] = v },
            set_index: (a: any, i: number, v: any) => { a[i] = v },
            push: (a: any, v: any) => { a.push(v) },
            get: (o: any, k: any) => (o == null ? null : (o[k] ?? null)),
            get_index: (a: any, i: number) => (a == null ? null : (a[i] ?? null)),
            len: (v: any) => (v == null ? 0 : (v.length | 0)),
            has: (o: any, k: any) => (o != null && (k in Object(o))) ? 1 : 0,
            keys: (o: any) => (o == null ? [] : Object.keys(o)),
            typeof: (v: any) => Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v),
            is_null: (v: any) => (v == null) ? 1 : 0,
            from_int: (n: number) => n,
            from_float: (n: number) => n,
            from_bool: (b: number) => b !== 0,
            from_str: (s: any) => s,
            as_int: (v: any) => (v | 0),
            as_float: (v: any) => +v,
            as_bool: (v: any) => v ? 1 : 0,
            as_str: (v: any) => String(v),
            global: (name: any) => (globalThis as any)[name],
            // Fallible invokers (#2): run a host call, catching any throw into the
            // boundary error slot and returning null instead of trapping.  `args`
            // is a JSValue array handle (build it with js::array + js::push).
            call: (recv: any, method: any, args: any) => {
                errBox.last = null
                try { return recv[method](...(args ?? [])) } catch (e) { errBox.last = e; return null }
            },
            apply: (fn: any, args: any) => {
                errBox.last = null
                try { return fn(...(args ?? [])) } catch (e) { errBox.last = e; return null }
            },
            construct: (ctor: any, args: any) => {
                errBox.last = null
                try { return new ctor(...(args ?? [])) } catch (e) { errBox.last = e; return null }
            },
            // Boundary error channel.  `had_error` peeks; `error_message`/`take_error`
            // read-and-clear so the next op starts clean.
            had_error: () => (errBox.last != null ? 1 : 0),
            take_error: () => { const e = errBox.last; errBox.last = null; return e ?? null },
            error_message: () => {
                const e = errBox.last; errBox.last = null
                const msg = e == null ? '' : String((e && e.message) != null ? e.message : e)
                return allocLenString(msg)
            },
            clear_error: () => { errBox.last = null },
            // Pin a handle to thread it through a linear-memory Result by id.
            pin: (v: any) => { pins.push(v); return pins.length - 1 },
            pinned: (i: number) => (pins[i] ?? null),
            unpin: (i: number) => { if (i > 0 && i < pins.length) pins[i] = null },
        },
        bun: {
            // === bindgen:module bun ===
            alloc_unsafe: (size: number) => Bun.allocUnsafe(size),
            build: (config: any) => Bun.build(config),
            concat_array_buffers: (buffers: any, maxLength: number) => Bun.concatArrayBuffers(buffers, maxLength),
            connect: (options: any) => Bun.connect(options),
            deep_equals: (a: any, b: any, strict: number) => Bun.deepEquals(a, b, strict),
            gc: (force: number) => Bun.gc(force),
            generate_heap_snapshot: (format: any) => Bun.generateHeapSnapshot(format),
            inspect: (arg: any, options: any) => Bun.inspect(arg, options),
            listen: (options: any) => Bun.listen(options),
            nanoseconds: () => Bun.nanoseconds(),
            open_in_editor: (path: any, options: any) => Bun.openInEditor(path, options),
            path_to_file_url: (path: any) => Bun.pathToFileURL(path),
            random_uuidv7: (encoding: any) => Bun.randomUUIDv7(encoding),
            readable_stream_to_blob: (stream: any) => Bun.readableStreamToBlob(stream),
            readable_stream_to_form_data: (stream: any) => Bun.readableStreamToFormData(stream),
            readable_stream_to_json: (stream: any) => Bun.readableStreamToJSON(stream),
            readable_stream_to_text: (stream: any) => Bun.readableStreamToText(stream),
            resolve: (moduleId: any, parent: any) => Bun.resolve(moduleId, parent),
            resolve_sync: (moduleId: any, parent: any) => Bun.resolveSync(moduleId, parent),
            shrink: () => Bun.shrink(),
            sleep_sync: (ms: number) => Bun.sleepSync(ms),
            slice_ansi: (input: any, start: number, end: number, ambiguousIsNarrow: number) => Bun.sliceAnsi(input, start, end, ambiguousIsNarrow),
            string_width: (input: any, options: any) => Bun.stringWidth(input, options),
            strip_ansi: (input: any) => Bun.stripANSI(input),
            udp_socket: (options: any) => Bun.udpSocket(options),
            which: (command: any, options: any) => Bun.which(command, options),
            wrap_ansi: (input: any, columns: number, options: any) => Bun.wrapAnsi(input, columns, options),
            // === /bindgen:module bun ===
        },
        // Constructed Web interfaces (Tier-2): `create` constructs the object and
        // returns a JSValue handle; methods/getters/setters take it as `self`.
        // The global (URL/Headers/TextEncoder/…) must be in host scope (it is in Bun).
        url: {
            // === bindgen:module url ===
            create_object_url: (obj: any) => URL.createObjectURL(obj),
            revoke_object_url: (url: any) => URL.revokeObjectURL(url),
            create: (url: any) => new URL(url),
            parse: (url: any) => URL.parse(url),
            can_parse: (url: any) => URL.canParse(url),
            to_string: (self: any) => self.toString(),
            href: (self: any) => self.href,
            set_href: (self: any, value: any) => self.href = value,
            origin: (self: any) => self.origin,
            protocol: (self: any) => self.protocol,
            set_protocol: (self: any, value: any) => self.protocol = value,
            username: (self: any) => self.username,
            set_username: (self: any, value: any) => self.username = value,
            password: (self: any) => self.password,
            set_password: (self: any, value: any) => self.password = value,
            host: (self: any) => self.host,
            set_host: (self: any, value: any) => self.host = value,
            hostname: (self: any) => self.hostname,
            set_hostname: (self: any, value: any) => self.hostname = value,
            port: (self: any) => self.port,
            set_port: (self: any, value: any) => self.port = value,
            pathname: (self: any) => self.pathname,
            set_pathname: (self: any, value: any) => self.pathname = value,
            search: (self: any) => self.search,
            set_search: (self: any, value: any) => self.search = value,
            search_params: (self: any) => self.searchParams,
            hash: (self: any) => self.hash,
            set_hash: (self: any, value: any) => self.hash = value,
            to_json: (self: any) => self.toJSON(),
            // === /bindgen:module url ===
        },
        url_search_params: {
            // === bindgen:module url_search_params ===
            create: (init: any) => new URLSearchParams(init),
            size: (self: any) => self.size,
            append: (self: any, name: any, value: any) => self.append(name, value),
            delete: (self: any, name: any) => self.delete(name),
            get: (self: any, name: any) => self.get(name),
            has: (self: any, name: any) => self.has(name),
            set: (self: any, name: any, value: any) => self.set(name, value),
            sort: (self: any) => self.sort(),
            to_string: (self: any) => self.toString(),
            // === /bindgen:module url_search_params ===
        },
        headers: {
            // === bindgen:module headers ===
            create: () => new Headers(),
            append: (self: any, name: any, value: any) => self.append(name, value),
            delete: (self: any, name: any) => self.delete(name),
            get: (self: any, name: any) => self.get(name),
            has: (self: any, name: any) => self.has(name),
            set: (self: any, name: any, value: any) => self.set(name, value),
            // === /bindgen:module headers ===
        },
        text_encoder: {
            // === bindgen:module text_encoder ===
            create: () => new TextEncoder(),
            encode: (self: any, input: any) => self.encode(input),
            encoding: (self: any) => self.encoding,
            // === /bindgen:module text_encoder ===
        },
        text_decoder: {
            // === bindgen:module text_decoder ===
            create: (label: any) => new TextDecoder(label),
            decode: (self: any, input: any) => self.decode(input),
            encoding: (self: any) => self.encoding,
            fatal: (self: any) => self.fatal,
            ignore_bom: (self: any) => self.ignoreBOM,
            // === /bindgen:module text_decoder ===
        },
    }
    return { imports, flush, errBox }
}

/** Compile + instantiate `binary` under Bun with js-string builtins and run
 *  `_start`.  Returns the process exit code (0 on success).
 *
 *  When `suspendingImports` is non-empty (the program has `@suspending @extern`
 *  imports — ADR 0018), the run is driven through the async reactor instead of a
 *  one-shot `_start`: the suspending imports' host functions (Promise-returning)
 *  are wrapped, and the backend is chosen at load time — JSPI when the engine
 *  has it (Bun ≥ 1.3 / V8), else Asyncify route-B precise coloring. */
export async function runUnderBun(
    binary: Uint8Array,
    opts: {
        suspendingImports?: readonly string[]
        /** Promise-returning host impls for suspending imports, keyed by
         *  `module.field` (where the FFI async-binding layer — `fetch`, timers —
         *  registers them; also the injection point for tests). */
        hostAsync?: Record<string, (...a: number[]) => unknown>
    } = {},
): Promise<number> {
    const state: HostState = {}
    const { imports, flush, errBox } = buildImports(state, s => process.stdout.write(s))

    // Next FFI work #2 — turn a Promise rejection into a caught boundary error
    // instead of a fatal trap: the awaited value becomes `null` and the rejection
    // is recorded in `errBox`, so guest code reads `js::had_error()` after the
    // `@await` and lifts it into a `Result` (stdlib `ffi.si`) exactly like a sync
    // throw.  Each call resets the slot first (last-op semantics).
    const captureRejections = (fn: (...a: number[]) => any) => async (...a: number[]) => {
        errBox.last = null
        try { return await fn(...a) } catch (e) { errBox.last = e; return null }
    }

    // Async path: a program with suspending imports yields to a reactor.
    const suspending = opts.suspendingImports ?? []
    if (suspending.length > 0) {
        const { runWithReactor } = await import('@silicon/compiler')
        // Suspending imports' host functions come from the base import object OR
        // the injected async surface; collect them as the async-impl set (the
        // reactor wraps them) and drop them from the synchronous base.
        const asyncImpls: Record<string, (...a: number[]) => any> = {}
        for (const [name, fn] of Object.entries(opts.hostAsync ?? {})) asyncImpls[name] = captureRejections(fn)
        for (const name of suspending) {
            const dot = name.indexOf('.')
            const mod = dot === -1 ? 'env' : name.slice(0, dot)
            const field = dot === -1 ? name : name.slice(dot + 1)
            const host = (imports as any)[mod]?.[field]
            if (typeof host === 'function') { asyncImpls[name] = captureRejections(host); delete (imports as any)[mod][field] }
        }
        try {
            await runWithReactor(binary, {
                baseImports: imports, asyncImpls, suspendingImports: [...suspending],
                entry: '_start', compileOptions: { builtins: ['js-string'] } as any,
                bind: (inst) => {
                    const ex = inst.exports as any
                    if (ex.memory instanceof WebAssembly.Memory) state.memory = ex.memory
                    if (typeof ex.alloc === 'function') state.alloc = ex.alloc
                },
            })
            flush()
            return 0
        } catch (e) {
            flush()
            console.error(`sgl run: async trap — ${(e as Error).message}`)
            return 1
        }
    }

    let module: WebAssembly.Module
    try {
        // The js-string builtins opt-in lives on compile (verified under Bun).
        module = await WebAssembly.compile(binary, { builtins: ['js-string'] } as WebAssembly.CompileOptions)
    } catch (e) {
        console.error(`sgl run: module failed to compile under Bun — ${(e as Error).message}`)
        console.error('  (the web/bun platform needs a Bun/JS host with JS String Builtins support)')
        return 1
    }

    const instance = await WebAssembly.instantiate(module, imports)
    const ex = instance.exports as Record<string, unknown>
    if (ex.memory instanceof WebAssembly.Memory) state.memory = ex.memory
    if (typeof ex.alloc === 'function') state.alloc = ex.alloc as (n: number) => number

    try {
        if (typeof ex._start === 'function') (ex._start as () => void)()
        else if (typeof ex.main === 'function') (ex.main as () => void)()
    } catch (e) {
        flush()
        console.error(`sgl run: trap — ${(e as Error).message}`)
        return 1
    }
    flush()
    return 0
}
