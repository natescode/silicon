// SPDX-License-Identifier: MIT
/**
 * FFI follow-up #3 — the generated Node `fs` module runs end-to-end.
 *
 * `fs.si` (from @types/node) was unblocked by the dts mixed-union fix:
 * `PathOrFileDescriptor` = `string | Buffer | URL | number` now binds as a
 * String path, so readFileSync/writeFileSync/existsSync/… generate.  This writes
 * + reads + stats a real temp file through the generated bindings.
 */
import { test, expect, describe, afterAll } from 'bun:test'
import { compile } from '../src/caas/index'
import { loadModules } from '../src/modules/loader'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'

const mods = loadModules(process.cwd())
const TMP = join(tmpdir(), 'silicon-fs-module-test.txt')
afterAll(() => { try { unlinkSync(TMP) } catch { /* ignore */ } })

function compileBin(src: string): Uint8Array {
    const r: any = compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return r.binary
}

/** The `fs` host shim (mirrors the generated js-host.ts block). */
const fsHost = {
    exists_sync: (path: any) => require('node:fs').existsSync(path),
    write_file_sync: (path: any, data: any, options: any) => require('node:fs').writeFileSync(path, data, options),
    read_file_sync: (path: any, options: any) => require('node:fs').readFileSync(path, options),
}

describe('bindgen — generated Node fs module (FFI #3)', () => {
    test('write → exists → read round-trips a real file through fs::*', async () => {
        const bin = compileBin(`\\\\ writef (JSString, JSString, JSString) -> Void
@fn writef path, data, enc := { fs::write_file_sync(path, data, enc) };
\\\\ readf (JSString, JSString) -> JSString
@fn readf path, enc := { fs::read_file_sync(path, enc) };
\\\\ has (JSString) -> Bool
@fn has path := { fs::exists_sync(path) };
@export writef;
@export readf;
@export has;`)
        const inst = new WebAssembly.Instance(await WebAssembly.compile(bin, { builtins: ['js-string'] } as any), {
            env: { print: () => {}, read: () => 0 }, fs: fsHost,
        })
        const ex = inst.exports as any
        try { unlinkSync(TMP) } catch { /* fresh */ }
        expect(ex.has(TMP)).toBe(0)                       // not there yet
        ex.writef(TMP, 'hello from silicon fs', 'utf8')   // fs::write_file_sync
        expect(ex.has(TMP)).toBe(1)                       // fs::exists_sync
        expect(ex.readf(TMP, 'utf8')).toBe('hello from silicon fs')  // fs::read_file_sync
        expect(existsSync(TMP)).toBe(true)                // and the host agrees
    })
})
