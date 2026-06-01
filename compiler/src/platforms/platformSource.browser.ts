// SPDX-License-Identifier: MIT
// Browser variant of platformSource.ts — serves inlined platform assets, no fs.
import { PLATFORM_WEB } from '../assets.generated'

const PLATFORMS: Record<string, { meta: unknown; files: Record<string, string> }> = {
    web: PLATFORM_WEB,
}

export function loadPlatformMetaRaw(platform: string): string | undefined {
    const p = PLATFORMS[platform]
    return p ? JSON.stringify(p.meta) : undefined
}

export function loadPlatformFileRaw(platform: string, file: string): string | undefined {
    return PLATFORMS[platform]?.files[file]
}
