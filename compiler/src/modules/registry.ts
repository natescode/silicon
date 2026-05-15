import type { WasmValType } from '../ir/nodes'

export interface FnSig {
    params: WasmValType[]
    result?: WasmValType
}

export interface ModuleEntry {
    name: string
    kind: 'env' | 'user'
    functions: Map<string, FnSig>
}

export type ModuleRegistry = Map<string, ModuleEntry>
