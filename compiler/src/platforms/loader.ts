// SPDX-License-Identifier: MIT
/**
 * Platform Loader
 *
 * Builds a ModuleRegistry from the platform feature files selected by PlatformConfig.
 * Each platform lives under src/platforms/<name>/ and consists of:
 *   - core.si         always loaded (console, math, time)
 *   - <feature>.si    loaded when the feature is enabled
 *   - platform.json   metadata (feature list, requiresExport constraints)
 *
 * The resulting ModuleRegistry uses the platform name as the module namespace
 * (e.g. 'web') — identical to what loadModules() produced from web.si.
 * Downstream typechecker and codegen are unchanged.
 */

import type { ModuleRegistry, ModuleEntry, FnSig } from '../modules/registry'
import { parseModuleDecls } from '../modules/loader'
import type { PlatformConfig } from './config'
import { loadPlatformMetaRaw, loadPlatformFileRaw } from './platformSource'

export interface FeatureMeta {
    name: string
    file: string
    runtime?: string
    requiresExport?: string
}

export interface PlatformMeta {
    name: string
    version: string
    features: FeatureMeta[]
}

export function loadPlatformMeta(platformName: string): PlatformMeta | undefined {
    const raw = loadPlatformMetaRaw(platformName)
    if (raw === undefined) return undefined
    try {
        return JSON.parse(raw) as PlatformMeta
    } catch {
        return undefined
    }
}

/**
 * Load a platform's extern declarations into a ModuleRegistry.
 * Always loads core.si; loads each enabled feature's .si file on top.
 */
export function loadPlatform(config: PlatformConfig): ModuleRegistry {
    const { platform, features } = config
    const functions = new Map<string, FnSig>()

    // Always load core
    const coreSrc = loadPlatformFileRaw(platform, 'core.si')
    if (coreSrc !== undefined) {
        for (const [name, sig] of parseModuleDecls(coreSrc)) {
            functions.set(name, sig)
        }
    }

    // Load each enabled feature
    const meta = loadPlatformMeta(platform)
    for (const featureName of features) {
        const featureMeta = meta?.features.find(f => f.name === featureName)
        const featureFile = featureMeta?.file ?? `${featureName}.si`
        const featureSrc = loadPlatformFileRaw(platform, featureFile)
        if (featureSrc !== undefined) {
            for (const [name, sig] of parseModuleDecls(featureSrc)) {
                functions.set(name, sig)
            }
        }
    }

    const entry: ModuleEntry = { name: platform, kind: 'env', functions }
    const registry: ModuleRegistry = new Map()
    registry.set(platform, entry)
    return registry
}

/**
 * Return which features in a PlatformConfig have a requiresExport constraint,
 * along with the export name required. Used by the type-checker.
 */
export function getRequiredExports(config: PlatformConfig): Map<string, string> {
    const required = new Map<string, string>()
    const meta = loadPlatformMeta(config.platform)
    if (!meta) return required
    for (const f of meta.features) {
        if (config.features.includes(f.name) && f.requiresExport) {
            required.set(f.name, f.requiresExport)
        }
    }
    return required
}
