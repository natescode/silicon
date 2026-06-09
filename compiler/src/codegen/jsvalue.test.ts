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
    // handle FFI surface) would trigger it; that surface is the remaining F1a
    // work (bare-`@extern` externref + import-module override).
})
