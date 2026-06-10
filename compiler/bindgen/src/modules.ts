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
import { buildIR, emitModuleSi, emitHostModule, type BindingIR, type StringTier } from './generate'
import type { BindingSpec } from './spec'

export interface ModuleConfig {
    /** Import-module name → called as `<module>::<fn>`; the `.si` file is `<module>.si`. */
    readonly module: string
    /** Provenance string for the generated-file header. */
    readonly provenance: string
    /** Run the source adapter to produce the bindings. */
    readonly specs: () => BindingSpec[]
    /** String boundary tier (ADR 0017): 'linear' (Tier-0, every target) or
     *  'jsstring' (Tier-1, externref, web/bun only).  Default 'linear'. */
    readonly strings?: StringTier
}

/** The modules generated and shipped today.  Each is spec-driven (Node from
 *  @types/node, Bun from bun-types, both via the TS compiler API). */
export const GENERATED_MODULES: readonly ModuleConfig[] = [
    {
        // Node path: Tier-0 — linear String, portable to any host.
        module: 'path',
        provenance: '@types/node (node:path)',
        specs: () => dtsToSpecs({ module: 'node:path', types: ['node'], accessor: "require('node:path')", prefix: '' }).specs,
        strings: 'linear',
    },
    {
        // Bun: Tier-1 — JSString (externref).  Bun is a JS host, so its string
        // bindings cross as native JS strings with zero linear-memory marshalling.
        module: 'bun',
        provenance: 'bun-types (global Bun)',
        specs: () => dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: '' }).specs,
        strings: 'jsstring',
    },
]

export function generateModule(cfg: ModuleConfig): { ir: BindingIR; si: string; hostShim: string } {
    const ir = buildIR(cfg.module, cfg.specs())
    const strings = cfg.strings ?? 'linear'
    return { ir, si: emitModuleSi(ir, cfg.provenance, strings), hostShim: emitHostModule(ir, undefined, strings) }
}
