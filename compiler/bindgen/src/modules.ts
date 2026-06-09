// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — generated built-in modules (Node / Bun).
 *
 * Each entry turns a spec-driven adapter into a shipped Silicon module: a
 * `compiler/src/strata/modules/<module>.si` file (auto-bundled, callable as
 * `<module>::<fn>`) plus a marshalling host-shim spliced into `js-host.ts`.
 * Unlike the Web Math/clock surface (fragments inside existing files), these are
 * whole generated modules.
 */

import { dtsToSpecs } from './adapters/dts'
import { buildIR, emitModuleSi, emitHostModule, type BindingIR } from './generate'
import type { BindingSpec } from './spec'

export interface ModuleConfig {
    /** Import-module name → called as `<module>::<fn>`; the `.si` file is `<module>.si`. */
    readonly module: string
    /** Provenance string for the generated-file header. */
    readonly provenance: string
    /** Run the source adapter to produce the (Tier-0) bindings. */
    readonly specs: () => BindingSpec[]
}

/** The modules generated and shipped today.  Each is spec-driven (Node from
 *  @types/node, Bun from bun-types, both via the TS compiler API). */
export const GENERATED_MODULES: readonly ModuleConfig[] = [
    {
        module: 'path',
        provenance: '@types/node (node:path)',
        specs: () => dtsToSpecs({ module: 'node:path', types: ['node'], accessor: "require('node:path')", prefix: '' }).specs,
    },
    {
        module: 'bun',
        provenance: 'bun-types (global Bun)',
        specs: () => dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: '' }).specs,
    },
]

export function generateModule(cfg: ModuleConfig): { ir: BindingIR; si: string; hostShim: string } {
    const ir = buildIR(cfg.module, cfg.specs())
    return { ir, si: emitModuleSi(ir, cfg.provenance), hostShim: emitHostModule(ir) }
}
