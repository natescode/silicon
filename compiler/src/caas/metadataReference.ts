// SPDX-License-Identifier: MIT
/**
 * MetadataReference — consume a precompiled Silicon library's public symbol
 * surface without its source (CaaS tracker 3c).
 *
 * A `SymbolManifest` is the library's exported symbols (name + kind + type
 * signature), the CaaS analogue of Roslyn's `MetadataReference`.  It is plain
 * JSON-serializable data (a `SiliconType` is a plain discriminated union), so a
 * package can ship its manifest alongside its `.wasm`.  Adding a reference to a
 * `Workspace` (or `Project`) makes its symbols available for cross-document type
 * checking, hover, and completion — code can call into the library without
 * having (or recompiling) its source.
 *
 * @public — Silicon 1.0 stable.
 */

import type { SiliconType } from '../types/types'
import type { Symbol as CaaSSymbol, SymbolKind } from '../ast/semanticModel'
import { symbolDisplayString } from '../ast/semanticModel'

/** One exported symbol in a library's manifest. */
export interface ManifestSymbol {
    /** Symbol name as referenced from consuming code. */
    readonly name: string
    /** What kind of symbol it is (function, variable, type, …). */
    readonly kind: SymbolKind
    /** The symbol's type signature. */
    readonly type: SiliconType
    /** Optional doc string surfaced on hover / completion. */
    readonly doc?: string
}

/** The public symbol surface of a precompiled Silicon library. */
export interface SymbolManifest {
    /** Library name, e.g. `'std'` — also the reference's identity in a workspace. */
    readonly name: string
    /** Exported symbols. */
    readonly symbols: readonly ManifestSymbol[]
}

/** Synthetic AST-node placeholder for a metadata symbol (it has no source node). */
interface MetadataSymbolNode {
    readonly type: 'MetadataSymbol'
    readonly name: string
    readonly reference: string
}

/**
 * A loaded reference to a precompiled library's symbols.  Obtain one via
 * {@link Workspace.addReference} / `Project.addReference`; never construct
 * directly for workspace use, though the constructor is public for standalone
 * manifest inspection.
 *
 * @public — Silicon 1.0 stable.
 */
export class MetadataReference {
    /** The library name (the manifest's `name`). */
    readonly name: string
    /** Exported symbols, keyed by name. */
    readonly symbols: ReadonlyMap<string, ManifestSymbol>

    constructor(manifest: SymbolManifest) {
        this.name = manifest.name
        this.symbols = new Map(manifest.symbols.map(s => [s.name, s]))
    }

    /** Look up an exported symbol by name. */
    symbolNamed(name: string): ManifestSymbol | undefined {
        return this.symbols.get(name)
    }

    /** The synthetic URI under which this reference's symbols are indexed. */
    get uri(): string {
        return `metadata:${this.name}`
    }

    /**
     * Synthesize {@link CaaSSymbol}s for this reference's exports, for the
     * workspace symbol index (hover / completion / go-to-definition).  They carry
     * no `definitionSpan` (there is no source), but do carry a `displayString`.
     */
    caasSymbols(): CaaSSymbol[] {
        return [...this.symbols.values()].map(ms => {
            const definitionNode: MetadataSymbolNode = {
                type: 'MetadataSymbol', name: ms.name, reference: this.name,
            }
            const partial = {
                name: ms.name,
                kind: ms.kind,
                definitionNode,
                type: ms.type,
                definitionSpan: undefined,
                locations: [] as const,
                containingSymbol: undefined,
                isImplicitlyDeclared: false,   // a real (external) declaration, not synthesized
            }
            return { ...partial, displayString: symbolDisplayString(partial as CaaSSymbol) }
        })
    }
}

/** Serialize a manifest to JSON (the on-disk package-manifest form). */
export function serializeManifest(manifest: SymbolManifest): string {
    return JSON.stringify(manifest)
}

/** Parse a manifest from JSON produced by {@link serializeManifest}. */
export function parseManifest(json: string): SymbolManifest {
    return JSON.parse(json) as SymbolManifest
}
