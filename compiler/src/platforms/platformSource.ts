// SPDX-License-Identifier: MIT
// Filesystem reads of platform metadata and feature .si files (Node/Bun).
// The browser build swaps this for platformSource.browser.ts (inlined copy).
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const PLATFORMS_DIR = dirname(fileURLToPath(import.meta.url))  // src/platforms/

export function loadPlatformMetaRaw(platform: string): string | undefined {
    const p = join(PLATFORMS_DIR, platform, 'platform.json')
    return existsSync(p) ? readFileSync(p, 'utf-8') : undefined
}

export function loadPlatformFileRaw(platform: string, file: string): string | undefined {
    const p = join(PLATFORMS_DIR, platform, file)
    return existsSync(p) ? readFileSync(p, 'utf-8') : undefined
}
