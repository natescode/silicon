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
            set_priority: (pid: number, priority: number) => require('node:os').setPriority(pid, priority),
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
            // Bulk binary marshalling (#2): copy bytes between guest linear memory
            // and a host typed array.  Coerce anything byte-ish to a Uint8Array view.
            byte_length: (h: any) => (h == null ? 0 : ((h.byteLength ?? h.length ?? 0) | 0)),
            u8: (h: any) => (h instanceof Uint8Array ? h
                : h instanceof ArrayBuffer ? new Uint8Array(h)
                : new Uint8Array(h.buffer, h.byteOffset, h.byteLength)),
            bytes_in: (ptr: number, len: number) => {
                if (!state.memory) return new Uint8Array(0)
                // Copy (not view): a later memory.grow would detach a view.
                return new Uint8Array(state.memory.buffer.slice(ptr, ptr + len))
            },
            bytes_out: (h: any, ptr: number, len: number) => {
                if (!state.memory || h == null) return 0
                const src = h instanceof Uint8Array ? h
                    : h instanceof ArrayBuffer ? new Uint8Array(h)
                    : new Uint8Array(h.buffer, h.byteOffset, h.byteLength)
                const n = Math.min(len, src.length)
                new Uint8Array(state.memory.buffer, ptr, n).set(src.subarray(0, n))
                return n
            },
        },
        // `stream` (Tier-2, #3): the JS iteration protocol — a guest `@loop`
        // pulls values from any host iterable.  See strata/modules/stream.si.
        stream: {
            iter: (it: any) => it[Symbol.iterator](),
            next: (it: any) => it.next(),
            value: (step: any) => (step == null ? null : (step.value ?? null)),
            done: (step: any) => (step != null && step.done ? 1 : 0),
            aiter: (it: any) => it[Symbol.asyncIterator](),
            anext: (it: any) => it.next(),   // Promise<{value,done}> — @suspending awaits it
        },
        // `promise` (Tier-2, #4): host Promise combinators — the guest kicks off
        // concurrent work (js::apply returns the pending Promise) then joins it
        // with one @await.  All @suspending.  See strata/modules/promise.si.
        promise: {
            all: (ps: any) => Promise.all(ps),
            race: (ps: any) => Promise.race(ps),
            all_settled: (ps: any) => Promise.allSettled(ps),
            any: (ps: any) => Promise.any(ps),
            value: (p: any) => Promise.resolve(p),   // await a single handle
            // F3 poll-reactor bridge: watch a Promise non-blockingly (token in the
            // shared pin table), and `tick` yields one event-loop turn so it settles.
            track: (p: any) => {
                const box = { done: 0, val: null as any }
                Promise.resolve(p).then(v => { box.done = 1; box.val = v }, e => { box.done = 2; box.val = e })
                pins.push(box); return pins.length - 1
            },
            settled: (tok: number) => (pins[tok] && pins[tok].done) ? 1 : 0,
            result: (tok: number) => (pins[tok] ? pins[tok].val : null),
            tick: () => new Promise<number>(r => setTimeout(() => r(0), 0)),
        },
        bun: {
            // === bindgen:module bun ===
            alloc_unsafe: (size: number) => Bun.allocUnsafe(size),
            build: (config: any) => Bun.build(config),
            color: (input: any, outputFormat: any) => Bun.color(input, outputFormat),
            concat_array_buffers: (buffers: any, maxLength: number, asUint8Array: number) => Bun.concatArrayBuffers(buffers, maxLength, asUint8Array),
            connect: (options: any) => Bun.connect(options),
            cron: (path: any, schedule: any, title: any) => Bun.cron(path, schedule, title),
            deep_equals: (a: any, b: any, strict: number) => Bun.deepEquals(a, b, strict),
            deflate_sync: (data: any, options: any) => Bun.deflateSync(data, options),
            escape_html: (input: any) => Bun.escapeHTML(input),
            fetch: (input: any, init: any) => Bun.fetch(input, init),
            file: (path: any, options: any) => Bun.file(path, options),
            file_urlto_path: (url: any) => Bun.fileURLToPath(url),
            gc: (force: number) => Bun.gc(force),
            generate_heap_snapshot: (format: any, encoding: any) => Bun.generateHeapSnapshot(format, encoding),
            gunzip_sync: (data: any, options: any) => Bun.gunzipSync(data, options),
            gzip_sync: (data: any, options: any) => Bun.gzipSync(data, options),
            index_of_line: (buffer: any, offset: number) => Bun.indexOfLine(buffer, offset),
            inflate_sync: (data: any, options: any) => Bun.inflateSync(data, options),
            inspect: (arg: any, options: any) => Bun.inspect(arg, options),
            listen: (options: any) => Bun.listen(options),
            mmap: (path: any, opts: any) => Bun.mmap(path, opts),
            nanoseconds: () => Bun.nanoseconds(),
            open_in_editor: (path: any, options: any) => Bun.openInEditor(path, options),
            path_to_file_url: (path: any) => Bun.pathToFileURL(path),
            random_uuidv5: (name: any, namespace: any, encoding: any) => Bun.randomUUIDv5(name, namespace, encoding),
            random_uuidv7: (encoding: any, timestamp: any) => Bun.randomUUIDv7(encoding, timestamp),
            readable_stream_to_blob: (stream: any) => Bun.readableStreamToBlob(stream),
            readable_stream_to_form_data: (stream: any, multipartBoundaryExcludingDashes: any) => Bun.readableStreamToFormData(stream, multipartBoundaryExcludingDashes),
            readable_stream_to_json: (stream: any) => Bun.readableStreamToJSON(stream),
            readable_stream_to_text: (stream: any) => Bun.readableStreamToText(stream),
            resolve: (moduleId: any, parent: any) => Bun.resolve(moduleId, parent),
            resolve_sync: (moduleId: any, parent: any) => Bun.resolveSync(moduleId, parent),
            sha: (input: any, encoding: any) => Bun.sha(input, encoding),
            shrink: () => Bun.shrink(),
            sleep: (ms: any) => Bun.sleep(ms),
            sleep_sync: (ms: number) => Bun.sleepSync(ms),
            slice_ansi: (input: any, start: number, end: number, options: any, ambiguousIsNarrow: number) => Bun.sliceAnsi(input, start, end, options, ambiguousIsNarrow),
            spawn: (cmds: any, options: any) => Bun.spawn(cmds, options),
            spawn_sync: (cmds: any, options: any) => Bun.spawnSync(cmds, options),
            string_width: (input: any, options: any) => Bun.stringWidth(input, options),
            strip_ansi: (input: any) => Bun.stripANSI(input),
            udp_socket: (options: any) => Bun.udpSocket(options),
            which: (command: any, options: any) => Bun.which(command, options),
            wrap_ansi: (input: any, columns: number, options: any) => Bun.wrapAnsi(input, columns, options),
            write: (destination: any, input: any, options: any) => Bun.write(destination, input, options),
            zstd_compress: (data: any, options: any) => Bun.zstdCompress(data, options),
            zstd_compress_sync: (data: any, options: any) => Bun.zstdCompressSync(data, options),
            zstd_decompress: (data: any) => Bun.zstdDecompress(data),
            zstd_decompress_sync: (data: any) => Bun.zstdDecompressSync(data),
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
        // ── fetch ecosystem + crypto (Tier-2, generated — next FFI #5) ──────────
        response: {
            // === bindgen:module response ===
            create: (body: any) => new Response(body),
            error: () => Response.error(),
            redirect: (url: any) => Response.redirect(url),
            type: (self: any) => self.type,
            url: (self: any) => self.url,
            redirected: (self: any) => self.redirected,
            status: (self: any) => self.status,
            ok: (self: any) => self.ok,
            status_text: (self: any) => self.statusText,
            headers: (self: any) => self.headers,
            clone: (self: any) => self.clone(),
            body: (self: any) => self.body,
            body_used: (self: any) => self.bodyUsed,
            array_buffer: (self: any) => self.arrayBuffer(),
            blob: (self: any) => self.blob(),
            bytes: (self: any) => self.bytes(),
            form_data: (self: any) => self.formData(),
            json: (self: any) => self.json(),
            text: (self: any) => self.text(),
            // === /bindgen:module response ===
        },
        request: {
            // === bindgen:module request ===
            create: (input: any) => new Request(input),
            method: (self: any) => self.method,
            url: (self: any) => self.url,
            headers: (self: any) => self.headers,
            destination: (self: any) => self.destination,
            referrer: (self: any) => self.referrer,
            referrer_policy: (self: any) => self.referrerPolicy,
            mode: (self: any) => self.mode,
            credentials: (self: any) => self.credentials,
            cache: (self: any) => self.cache,
            redirect: (self: any) => self.redirect,
            integrity: (self: any) => self.integrity,
            keepalive: (self: any) => self.keepalive,
            is_reload_navigation: (self: any) => self.isReloadNavigation,
            is_history_navigation: (self: any) => self.isHistoryNavigation,
            signal: (self: any) => self.signal,
            duplex: (self: any) => self.duplex,
            clone: (self: any) => self.clone(),
            target_address_space: (self: any) => self.targetAddressSpace,
            body: (self: any) => self.body,
            body_used: (self: any) => self.bodyUsed,
            array_buffer: (self: any) => self.arrayBuffer(),
            blob: (self: any) => self.blob(),
            bytes: (self: any) => self.bytes(),
            form_data: (self: any) => self.formData(),
            json: (self: any) => self.json(),
            text: (self: any) => self.text(),
            // === /bindgen:module request ===
        },
        blob: {
            // === bindgen:module blob ===
            create: () => new Blob(),
            size: (self: any) => self.size,
            type: (self: any) => self.type,
            slice: (self: any, start: number) => self.slice(start),
            stream: (self: any) => self.stream(),
            text: (self: any) => self.text(),
            array_buffer: (self: any) => self.arrayBuffer(),
            bytes: (self: any) => self.bytes(),
            // === /bindgen:module blob ===
        },
        form_data: {
            // === bindgen:module form_data ===
            create: (form: any) => new FormData(form),
            append: (self: any, name: any, value: any) => self.append(name, value),
            delete: (self: any, name: any) => self.delete(name),
            get: (self: any, name: any) => self.get(name),
            has: (self: any, name: any) => self.has(name),
            set: (self: any, name: any, value: any) => self.set(name, value),
            // === /bindgen:module form_data ===
        },
        abort_controller: {
            // === bindgen:module abort_controller ===
            create: () => new AbortController(),
            signal: (self: any) => self.signal,
            abort: (self: any) => self.abort(),
            // === /bindgen:module abort_controller ===
        },
        abort_signal: {
            // === bindgen:module abort_signal ===
            abort: () => AbortSignal.abort(),
            timeout: (milliseconds: number) => AbortSignal.timeout(milliseconds),
            aborted: (self: any) => self.aborted,
            throw_if_aborted: (self: any) => self.throwIfAborted(),
            // === /bindgen:module abort_signal ===
        },
        crypto: {
            // === bindgen:module crypto ===
            argon2_sync: (algorithm: any, parameters: any) => require('node:crypto').argon2Sync(algorithm, parameters),
            create_cipheriv: (algorithm: any, key: any, iv: any, options: any) => require('node:crypto').createCipheriv(algorithm, key, iv, options),
            create_decipheriv: (algorithm: any, key: any, iv: any, options: any) => require('node:crypto').createDecipheriv(algorithm, key, iv, options),
            create_diffie_hellman: (prime: any, primeEncoding: any, generator: any, generatorEncoding: any) => require('node:crypto').createDiffieHellman(prime, primeEncoding, generator, generatorEncoding),
            create_diffie_hellman_group: (name: any) => require('node:crypto').createDiffieHellmanGroup(name),
            create_ecdh: (curveName: any) => require('node:crypto').createECDH(curveName),
            create_hash: (algorithm: any, options: any) => require('node:crypto').createHash(algorithm, options),
            create_hmac: (algorithm: any, key: any, options: any) => require('node:crypto').createHmac(algorithm, key, options),
            create_private_key: (key: any) => require('node:crypto').createPrivateKey(key),
            create_public_key: (key: any) => require('node:crypto').createPublicKey(key),
            create_secret_key: (key: any, encoding: any) => require('node:crypto').createSecretKey(key, encoding),
            create_sign: (algorithm: any, options: any) => require('node:crypto').createSign(algorithm, options),
            create_verify: (algorithm: any, options: any) => require('node:crypto').createVerify(algorithm, options),
            decapsulate: (key: any, ciphertext: any) => require('node:crypto').decapsulate(key, ciphertext),
            diffie_hellman: (options: any) => require('node:crypto').diffieHellman(options),
            diffie_hellman_group: (name: any) => require('node:crypto').DiffieHellmanGroup(name),
            encapsulate: (key: any) => require('node:crypto').encapsulate(key),
            generate_key_pair_sync: (type: any) => require('node:crypto').generateKeyPairSync(type),
            generate_key_sync: (type: any, options: any) => require('node:crypto').generateKeySync(type, options),
            generate_prime_sync: (size: number) => require('node:crypto').generatePrimeSync(size),
            get_cipher_info: (nameOrNid: any, options: any) => require('node:crypto').getCipherInfo(nameOrNid, options),
            get_ciphers: () => require('node:crypto').getCiphers(),
            get_curves: () => require('node:crypto').getCurves(),
            get_diffie_hellman: (groupName: any) => require('node:crypto').getDiffieHellman(groupName),
            get_fips: () => require('node:crypto').getFips(),
            get_hashes: () => require('node:crypto').getHashes(),
            hash: (algorithm: any, data: any, options: any) => require('node:crypto').hash(algorithm, data, options),
            hkdf_sync: (digest: any, ikm: any, salt: any, info: any, keylen: number) => require('node:crypto').hkdfSync(digest, ikm, salt, info, keylen),
            pbkdf2_sync: (password: any, salt: any, iterations: number, keylen: number, digest: any) => require('node:crypto').pbkdf2Sync(password, salt, iterations, keylen, digest),
            private_decrypt: (privateKey: any, buffer: any) => require('node:crypto').privateDecrypt(privateKey, buffer),
            private_encrypt: (privateKey: any, buffer: any) => require('node:crypto').privateEncrypt(privateKey, buffer),
            pseudo_random_bytes: (size: number) => require('node:crypto').pseudoRandomBytes(size),
            public_decrypt: (key: any, buffer: any) => require('node:crypto').publicDecrypt(key, buffer),
            public_encrypt: (key: any, buffer: any) => require('node:crypto').publicEncrypt(key, buffer),
            random_bytes: (size: number) => require('node:crypto').randomBytes(size),
            random_int: (min: number, max: number) => require('node:crypto').randomInt(min, max),
            random_uuid: (options: any) => require('node:crypto').randomUUID(options),
            scrypt_sync: (password: any, salt: any, keylen: number, options: any) => require('node:crypto').scryptSync(password, salt, keylen, options),
            secure_heap_used: () => require('node:crypto').secureHeapUsed(),
            set_engine: (engine: any, flags: number) => require('node:crypto').setEngine(engine, flags),
            set_fips: (bool: number) => require('node:crypto').setFips(bool),
            sign: (algorithm: any, data: any, key: any) => require('node:crypto').sign(algorithm, data, key),
            timing_safe_equal: (a: any, b: any) => require('node:crypto').timingSafeEqual(a, b),
            verify: (algorithm: any, data: any, key: any, signature: any) => require('node:crypto').verify(algorithm, data, key, signature),
            // === /bindgen:module crypto ===
        },
        fs: {
            // === bindgen:module fs ===
            access_sync: (path: any, mode: number) => require('node:fs').accessSync(path, mode),
            append_file_sync: (path: any, data: any, options: any) => require('node:fs').appendFileSync(path, data, options),
            chmod_sync: (path: any, mode: any) => require('node:fs').chmodSync(path, mode),
            chown_sync: (path: any, uid: number, gid: number) => require('node:fs').chownSync(path, uid, gid),
            close: (fd: number) => require('node:fs').close(fd),
            close_sync: (fd: number) => require('node:fs').closeSync(fd),
            copy_file_sync: (src: any, dest: any, mode: number) => require('node:fs').copyFileSync(src, dest, mode),
            cp_sync: (source: any, destination: any, opts: any) => require('node:fs').cpSync(source, destination, opts),
            create_read_stream: (path: any, options: any) => require('node:fs').createReadStream(path, options),
            create_write_stream: (path: any, options: any) => require('node:fs').createWriteStream(path, options),
            exists_sync: (path: any) => require('node:fs').existsSync(path),
            fchmod_sync: (fd: number, mode: any) => require('node:fs').fchmodSync(fd, mode),
            fchown_sync: (fd: number, uid: number, gid: number) => require('node:fs').fchownSync(fd, uid, gid),
            fdatasync_sync: (fd: number) => require('node:fs').fdatasyncSync(fd),
            fstat_sync: (fd: number) => require('node:fs').fstatSync(fd),
            fsync_sync: (fd: number) => require('node:fs').fsyncSync(fd),
            ftruncate_sync: (fd: number, len: number) => require('node:fs').ftruncateSync(fd, len),
            futimes_sync: (fd: number, atime: any, mtime: any) => require('node:fs').futimesSync(fd, atime, mtime),
            glob_sync: (pattern: any) => require('node:fs').globSync(pattern),
            lchmod_sync: (path: any, mode: any) => require('node:fs').lchmodSync(path, mode),
            lchown_sync: (path: any, uid: number, gid: number) => require('node:fs').lchownSync(path, uid, gid),
            link_sync: (existingPath: any, newPath: any) => require('node:fs').linkSync(existingPath, newPath),
            lstat_sync: (path: any) => require('node:fs').lstatSync(path),
            lutimes_sync: (path: any, atime: any, mtime: any) => require('node:fs').lutimesSync(path, atime, mtime),
            mkdir_sync: (path: any, options: any) => require('node:fs').mkdirSync(path, options),
            mkdtemp_disposable_sync: (prefix: any, options: any) => require('node:fs').mkdtempDisposableSync(prefix, options),
            mkdtemp_sync: (prefix: any, options: any) => require('node:fs').mkdtempSync(prefix, options),
            open_sync: (path: any, flags: any, mode: any) => require('node:fs').openSync(path, flags, mode),
            opendir_sync: (path: any, options: any) => require('node:fs').opendirSync(path, options),
            read_file_sync: (path: any, options: any) => require('node:fs').readFileSync(path, options),
            read_sync: (fd: number, buffer: any, opts: any) => require('node:fs').readSync(fd, buffer, opts),
            readdir_sync: (path: any, options: any) => require('node:fs').readdirSync(path, options),
            readlink_sync: (path: any, options: any) => require('node:fs').readlinkSync(path, options),
            readv_sync: (fd: number, buffers: any, position: number) => require('node:fs').readvSync(fd, buffers, position),
            realpath_sync: (path: any, options: any) => require('node:fs').realpathSync(path, options),
            rename_sync: (oldPath: any, newPath: any) => require('node:fs').renameSync(oldPath, newPath),
            rm_sync: (path: any, options: any) => require('node:fs').rmSync(path, options),
            rmdir_sync: (path: any) => require('node:fs').rmdirSync(path),
            stat_sync: (path: any) => require('node:fs').statSync(path),
            statfs_sync: (path: any) => require('node:fs').statfsSync(path),
            symlink_sync: (target: any, path: any, type: any) => require('node:fs').symlinkSync(target, path, type),
            truncate_sync: (path: any, len: number) => require('node:fs').truncateSync(path, len),
            unlink_sync: (path: any) => require('node:fs').unlinkSync(path),
            unwatch_file: (filename: any) => require('node:fs').unwatchFile(filename),
            utimes_sync: (path: any, atime: any, mtime: any) => require('node:fs').utimesSync(path, atime, mtime),
            watch: (filename: any, options: any) => require('node:fs').watch(filename, options),
            write_file_sync: (file: any, data: any, options: any) => require('node:fs').writeFileSync(file, data, options),
            write_sync: (fd: number, string: any, position: number, encoding: any) => require('node:fs').writeSync(fd, string, position, encoding),
            writev_sync: (fd: number, buffers: any, position: number) => require('node:fs').writevSync(fd, buffers, position),
            // === /bindgen:module fs ===
        },
        global: {
            // === bindgen:module global ===
            atob: (data: any) => globalThis.atob(data),
            btoa: (data: any) => globalThis.btoa(data),
            fetch: (input: any, init: any) => globalThis.fetch(input, init),
            queue_microtask: (callback: any) => globalThis.queueMicrotask(closureToFn(callback)),
            // === /bindgen:module global ===
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
