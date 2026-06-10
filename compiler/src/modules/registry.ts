// SPDX-License-Identifier: MIT
import type { WasmValType } from '../ir/nodes'

export interface FnSig {
    params: WasmValType[]
    result?: WasmValType
    siliconParams: string[]
    siliconResult?: string
    /** ADR 0018 — a `@suspending @extern` (Promise-returning) module binding; the
     *  reactor drives the await when a program calls it through `@await`. */
    suspending?: boolean
}

export interface ModuleEntry {
    name: string
    kind: 'env' | 'user'
    functions: Map<string, FnSig>
}

export type ModuleRegistry = Map<string, ModuleEntry>
