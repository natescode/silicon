// SPDX-License-Identifier: MIT
/**
 * ADR 0018 P0 — `JSValue`, the generic host-object handle.
 *
 * `JSValue` is an opaque `externref` handle to *any* host (JS) object — the
 * type that lets a `Response` / `Uint8Array` / DOM node cross the `@extern`
 * boundary.  It reuses the `JSString` externref slot machinery
 * (`injectExternRefSlots`, the import `refParams`/`refResult`, the
 * `usesExternref` web/bun gate) without the `wasm:js-string` operations.
 */
import { describe, test, expect } from 'bun:test'
import { compile } from '../caas/index'
import { loadModules } from '../modules/loader'

const mods = loadModules(process.cwd())

function compileBun(src: string) {
    return compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
}

function compileNative(src: string) {
    return compile(src, { file: 'm.si', moduleRegistry: mods, target: 'native', platform: 'native', emitBinary: false } as any)
}

function importLines(wat: string): string[] {
    return (wat ?? '').split('\n').filter(l => l.includes('(import '))
}

describe('JSValue — generic externref object handle (ADR 0018 P0)', () => {
    test('a JSValue param and result lower to externref', () => {
        const r: any = compileBun(`\\\\ identity (JSValue) -> JSValue
@fn identity x := x;
@export identity;`)
        expect(r.diagnostics?.length ?? 0).toBe(0)
        // The function holds the host handle as a nullable externref slot.
        expect(r.wat).toContain('(param $x externref)')
        expect(r.wat).toContain('(result externref)')
    })

    test('a JSValue @local gets an externref slot', () => {
        const r: any = compileBun(`\\\\ pass (JSValue) -> JSValue
@fn pass v := {
    \\\\ h JSValue
    @mut h := v;
    h
};
@export pass;`)
        expect(r.diagnostics?.length ?? 0).toBe(0)
        expect(r.wat).toContain('(param $v externref)')
        // The local `h` holds the externref handle, not an i32.
        expect(r.wat).toMatch(/\(local \$h externref\)/)
    })

    test('externref binary valtype (0x6F) is emitted under Bun', async () => {
        const r: any = compileBun(`\\\\ identity (JSValue) -> JSValue
@fn identity x := x;
@export identity;`)
        const bytes: Uint8Array = r.binary
        expect(bytes).toBeTruthy()
        expect([...bytes].includes(0x6f)).toBe(true)   // externref heaptype byte
        // Module instantiates under Bun's WebAssembly (externref is engine-native).
        const mod = await WebAssembly.compile(bytes)
        expect(mod).toBeTruthy()
    })

    // NOTE: the web/bun platform gate fires on the externref *module-call* path
    // (`generalized usesExternref` in lowerModuleCall), not on a plain `@fn`
    // param/result — same as JSString. A JSValue host-module call (the object-
    // handle FFI surface) is exercised below.
})

/**
 * ADR 0018 P1 — the `@extern` object-handle FFI surface.  Generalizes the
 * former hardcoded `(import "env" <name>)` two ways: a namespaced `mod::field`
 * name imports from host module `mod`, and `JSString`/`JSValue` params/results
 * become `externref` slots (the object boundary).  Externref imports need a JS
 * host, so they are gated to `--platform=web|bun`.
 */
describe('@extern object-handle FFI surface (ADR 0018 P1)', () => {
    test('a bare @extern with a JSValue result imports an externref-returning func', () => {
        const r: any = compileBun(`\\\\ @extern get_thing (Int) -> JSValue;
\\\\ use (Int) -> JSValue
@fn use x := get_thing(x);
@export use;`)
        expect(r.diagnostics?.length ?? 0).toBe(0)
        const imp = importLines(r.wat).find(l => l.includes('get_thing')) ?? ''
        expect(imp).toContain('(import "env" "get_thing"')
        expect(imp).toContain('(result (ref extern))')
    })

    test('a bare @extern with a JSValue param imports an externref param', () => {
        const r: any = compileBun(`\\\\ @extern sink (JSValue) -> Void;
\\\\ use (JSValue) -> Void
@fn use v := sink(v);
@export use;`)
        expect(r.diagnostics?.length ?? 0).toBe(0)
        const imp = importLines(r.wat).find(l => l.includes('sink')) ?? ''
        expect(imp).toContain('(import "env" "sink"')
        expect(imp).toContain('(param externref)')
    })

    test('a namespaced @extern imports from its host module, not "env"', () => {
        const r: any = compileBun(`\\\\ @extern dom::get_element (JSValue) -> JSValue;
\\\\ use (JSValue) -> JSValue
@fn use x := dom::get_element(x);
@export use;`)
        expect(r.diagnostics?.length ?? 0).toBe(0)
        const imp = importLines(r.wat).find(l => l.includes('get_element')) ?? ''
        // module = "dom" (the namespace), field = "get_element"; wat id is mangled.
        expect(imp).toContain('(import "dom" "get_element"')
        expect(imp).toContain('$dom_get_element')
        expect(imp).toContain('(param externref) (result (ref extern))')
    })

    test('a namespaced @extern forward-references (declared after the call)', () => {
        const r: any = compileBun(`\\\\ use (JSValue) -> JSValue
@fn use x := dom::get_element(x);
\\\\ @extern dom::get_element (JSValue) -> JSValue;
@export use;`)
        expect(r.diagnostics?.length ?? 0).toBe(0)
        expect(importLines(r.wat).some(l => l.includes('(import "dom" "get_element"'))).toBe(true)
    })

    test('an externref @extern on a non-JS platform is a compile error', () => {
        const r: any = compileNative(`\\\\ @extern get_thing (Int) -> JSValue;
\\\\ use (Int) -> JSValue
@fn use x := get_thing(x);
@export use;`)
        expect(r.diagnostics?.length ?? 0).toBeGreaterThan(0)
        expect(JSON.stringify(r.diagnostics)).toContain('externref object handle')
    })

    test('a plain scalar @extern still imports from "env" (no externref)', () => {
        const r: any = compileBun(`\\\\ @extern print (Int) -> Void;
\\\\ use (Int) -> Void
@fn use x := print(x);
@export use;`)
        expect(r.diagnostics?.length ?? 0).toBe(0)
        const imp = importLines(r.wat).find(l => l.includes('"print"')) ?? ''
        expect(imp).toContain('(import "env" "print" (func $print (param i32)))')
        expect(imp).not.toContain('extern')
    })
})
