// SPDX-License-Identifier: MIT
/**
 * Code Generation Module
 *
 * Stage 3 of the compilation pipeline: lower the type-annotated AST to an
 * IRModule, then emit WebAssembly Text format (WAT).
 *
 * @see ../ir - IR nodes, lowering, and emission
 * @see std.wat - Silicon runtime (alloc, print helpers, memory layout)
 */

import { loadStdWatRaw } from './stdWatSource'
import { lowerProgram, emitModule } from '../ir'
import type { LowerOptions } from '../ir/lower'
import type { IRModule } from '../ir/nodes'
import type { Program } from '../ast/astNodes'
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { FunctionSig } from '../types/typechecker'
import type { ModuleRegistry } from '../modules/registry'
import type { SemanticModel } from '../ast/semanticModel'
import { buildPrelude } from './prelude-ir'
import { emitWasmBinary } from './wasm-emitter'

export type { LowerTarget, LowerOptions } from '../ir/lower'

let cachedStdWat: string | null = null

/** Load the Silicon runtime (std.wat) once per process. */
export function loadStdWat(): string {
    if (!cachedStdWat) {
        cachedStdWat = loadStdWatRaw()
    }
    return cachedStdWat
}

/**
 * Strip the `env::print` / `env::read` imports and any helper functions
 * that reference them from std.wat.  Boot programs (target=wasix) run
 * under a WASI host that doesn't provide these; the host-embed targets
 * still want them so the playground / Bun runners keep working.
 */
function stripHostPrintImports(wat: string): string {
    let out = wat
        .replace(/^\(import "env" "print".*\)$\r?\n/m, '')
        .replace(/^\(import "env" "read".*\)$\r?\n/m, '')
    // Strip the four print helpers (each is a top-level (func ...) that
    // references $print or $read).  Walk paren depth so we land on the
    // matching close-paren regardless of internal structure.
    for (const name of ['$print_int', '$print_bool', '$print_float', '$print_string']) {
        const startMarker = `(func ${name}`
        const start = out.indexOf(startMarker)
        if (start < 0) continue
        let depth = 0
        let i = start
        for (; i < out.length; i++) {
            const c = out[i]
            if (c === '(') depth++
            else if (c === ')') { depth--; if (depth === 0) { i++; break } }
        }
        // Also gobble the trailing newline.
        while (i < out.length && (out[i] === '\r' || out[i] === '\n')) i++
        out = out.slice(0, start) + out.slice(i)
    }
    return out
}

/**
 * Compile a type-checked Silicon program to a WAT string.
 *
 * Calls lowerProgram → emitModule with the inlined Silicon runtime.
 * Throws IRLowerError on any IR lowering failure.
 */
/**
 * Compute a safe heap start address from the lowered IR's data
 * segments.  std.wat's default `$heap` initialiser of 1024 was fine
 * when modules had a handful of small string literals, but the boot
 * tree (multi-fixture parser harness) easily exceeds that and the
 * heap then overwrites string-literal data, silently corrupting
 * source bytes the parser reads back.
 *
 * Walks every IRDataSegment, sums its inline-escaped byte length,
 * and returns the smallest 16-byte-aligned address strictly past the
 * highest occupied byte — with a 256-byte safety margin.  Always at
 * least the std.wat default of 1024 so simple programs don't shift.
 */
function computeHeapBase(irModule: IRModule): number {
    let maxEnd = 0
    for (const seg of irModule.dataSegments) {
        // The `encoded` field is the WAT inline-string form with
        // \xx escapes for non-printable bytes.  Count real bytes.
        let bytes = 0
        const s = seg.encoded
        for (let i = 0; i < s.length; i++) {
            if (s[i] === '\\') { bytes++; i += 2 }
            else bytes++
        }
        const end = seg.offset + bytes
        if (end > maxEnd) maxEnd = end
    }
    const SAFETY_PAD = 256
    const ALIGN = 16
    const minHeap = Math.max(1024, maxEnd + SAFETY_PAD)
    return Math.ceil(minHeap / ALIGN) * ALIGN
}

/** Rewrite std.wat's `(global $heap …)` initialiser to `base`.
 *  Phase 9c-8: also rewrites the immutable `$heap_base` companion so
 *  `$heap_used` (= heap - heap_base) reports the right delta when the
 *  heap base shifts to make room for data segments. */
function setHeapBase(stdWat: string, base: number): string {
    return stdWat
        .replace(
            /\(global \$heap \(mut i32\) \(i32\.const \d+\)\)/,
            `(global $heap (mut i32) (i32.const ${base}))`,
        )
        .replace(
            /\(global \$heap_base i32 \(i32\.const \d+\)\)/,
            `(global $heap_base i32 (i32.const ${base}))`,
        )
}

/** Phase 9c-4: rewrite std.wat's `(memory 1)` to `(memory 1 N)` so the
 *  wasm memory is capped at N 64KB pages.  Used by the `--max-heap=N`
 *  CLI flag to exercise heap-exhaustion paths deterministically. */
function setMemoryMaxPages(stdWat: string, maxPages: number): string {
    return stdWat.replace(/\(memory 1\)/, `(memory 1 ${maxPages})`)
}

export function compileToWat(
    program: Program,
    registry: ElaboratorRegistry,
    functionSigs: Map<string, FunctionSig>,
    moduleRegistry?: ModuleRegistry,
    options: LowerOptions = {},
    semanticModel?: SemanticModel,
): string {
    const irModule = lowerProgram(program, registry, functionSigs, moduleRegistry, options, semanticModel)
    let std = loadStdWat()
    if (options.target === 'wasix') std = stripHostPrintImports(std)
    std = setHeapBase(std, computeHeapBase(irModule))
    if (options.maxHeapPages !== undefined) std = setMemoryMaxPages(std, options.maxHeapPages)
    return emitModule(irModule, std)
}

/**
 * Compile a type-checked Silicon program straight to a WASM binary.
 *
 * Emits binary directly from IR — no wabt dependency.
 */
export function compileToWasm(
    program: Program,
    registry: ElaboratorRegistry,
    functionSigs: Map<string, FunctionSig>,
    moduleRegistry?: ModuleRegistry,
    options: LowerOptions = {},
): Uint8Array {
    const irModule = lowerProgram(program, registry, functionSigs, moduleRegistry, options)
    return irModuleToWasm(irModule, options)
}

/**
 * Assemble an already-lowered IRModule to a WASM binary using the in-house
 * direct binary emitter — no `wabt`. Handles funcref/call_indirect too (the
 * emitter emits the type/table/element sections), so there is no WAT detour.
 *
 * Shared by compileToWasm and the comptime engine, which is what lets the
 * browser playground compile everything without shipping `wabt`.
 */
export function irModuleToWasm(irModule: IRModule, options: LowerOptions = {}): Uint8Array {
    const heapBase = computeHeapBase(irModule)
    const prelude = buildPrelude(heapBase, options.target !== 'wasix', options.maxHeapPages)
    return emitWasmBinary(prelude, irModule)
}
