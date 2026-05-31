// SPDX-License-Identifier: MIT
export type PlatformName = 'web' | 'node' | 'wasi'

export interface PlatformConfig {
    platform: PlatformName
    features: string[]  // short names: 'canvas', 'game', 'dom'
}

export function defaultWebConfig(): PlatformConfig {
    return { platform: 'web', features: ['canvas', 'game', 'dom'] }
}

export function allFeaturesConfig(platform: PlatformName = 'web'): PlatformConfig {
    return { platform, features: ['canvas', 'game', 'dom'] }
}
