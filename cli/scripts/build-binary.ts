// SPDX-License-Identifier: MIT
/**
 * Build standalone `sgl` binaries for release.
 *
 *   bun run cli/scripts/build-binary.ts [platform...]
 *
 * Two steps:
 *   1. Bundle src/sigil_cli.ts (target: bun) with the compiler's built-in
 *      assets INLINED — strata/std.wat/built-in modules/web platform come from
 *      assets.generated instead of `readdirSync`, because a `bun build
 *      --compile` binary has no source tree to scan (`/$bunfs/root` ENOENT).
 *      User-project files still use the real filesystem (moduleSources.native).
 *   2. `bun build --compile --target=<t>` that bundle into a native binary per
 *      platform (cross-compilation lives in the CLI flag, not the JS API).
 *
 * Output: cli/dist/sgl-<platform>  (one per requested platform; default: host).
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync } from 'fs'
import type { BunPlugin } from 'bun'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPILER = join(CLI, '..', 'compiler')
const DIST = join(CLI, 'dist')

// platform → bun --target triple
const PLATFORMS: Record<string, string> = {
    'linux-x86_64': 'bun-linux-x64',
    'linux-aarch64': 'bun-linux-arm64',
    'macos-x86_64': 'bun-darwin-x64',
    'macos-aarch64': 'bun-darwin-arm64',
}

function hostPlatform(): string {
    const os = process.platform === 'darwin' ? 'macos' : 'linux'
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    return `${os}-${arch}`
}

const requested = process.argv.slice(2).filter(a => a in PLATFORMS)
const targets = requested.length ? requested : [hostPlatform()]

// Swap the compiler's filesystem asset loaders for inlined / native variants.
const inlineAssets: BunPlugin = {
    name: 'inline-builtin-assets',
    setup(build) {
        build.onResolve({ filter: /[\\/](strataSource|stdWatSource|platformSource|moduleSources)$/ }, args => {
            const suffix = args.path.endsWith('moduleSources') ? '.native.ts' : '.browser.ts'
            return { path: join(dirname(args.importer), args.path + suffix) }
        })
    },
}

// Step 0: regenerate inlined assets.
await Bun.$`bun run ${join(COMPILER, 'scripts/gen-web-assets.ts')}`.quiet()

// Step 1: bundle to a single Bun-target JS with assets inlined.
mkdirSync(DIST, { recursive: true })
const bundlePath = join(DIST, 'sgl.bundled.js')
const result = await Bun.build({
    entrypoints: [join(CLI, 'src/sigil_cli.ts')],
    target: 'bun',
    plugins: [inlineAssets],
    outdir: DIST,
    naming: 'sgl.bundled.js',
})
if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
}
console.log(`bundled → ${bundlePath}`)

// Step 2: compile the bundle per platform.
for (const platform of targets) {
    const target = PLATFORMS[platform]
    const outfile = join(DIST, `sgl-${platform}`)
    const proc = Bun.spawnSync(['bun', 'build', '--compile', `--target=${target}`, bundlePath, '--outfile', outfile])
    if (proc.exitCode !== 0) {
        console.error(`✗ ${platform}: ${proc.stderr.toString()}`)
        process.exit(1)
    }
    console.log(`✓ ${platform} → ${outfile}`)
}
