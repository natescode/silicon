// SPDX-License-Identifier: MIT
/**
 * Package the built sgl binaries into release tarballs, INCLUDING the licenses.
 *
 *   bun run cli/scripts/build-binary.ts linux-x86_64 linux-aarch64 macos-x86_64 macos-aarch64
 *   bun run cli/scripts/package-release.ts v0.1.0
 *
 * Each tarball contains the binary plus the licenses that must travel with it:
 *   sgl-<version>-<platform>/
 *     ├── sgl                      the binary
 *     ├── LICENSE                  Silicon's MIT license
 *     └── THIRD-PARTY-LICENSES.md  the embedded Bun runtime's licenses
 *                                  (MIT + statically-linked JSC/WebKit LGPL-2, …)
 * plus a matching .sha256 the installer verifies.
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, copyFileSync, rmSync, chmodSync, readFileSync } from 'fs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(CLI, '..')
const DIST = join(CLI, 'dist')
const OUT = join(DIST, 'release')

const VERSION = process.argv[2]
if (!VERSION || !/^v\d+\.\d+\.\d+/.test(VERSION)) {
    console.error('usage: bun run cli/scripts/package-release.ts <vX.Y.Z>')
    process.exit(1)
}
const cliPackage = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf-8')) as { version?: string }
if (cliPackage.version !== VERSION.replace(/^v/, '')) {
    console.error(`package version mismatch: cli/package.json has ${cliPackage.version}, release tag is ${VERSION}`)
    process.exit(1)
}

const PLATFORMS = ['linux-x86_64', 'linux-aarch64', 'macos-x86_64', 'macos-aarch64']
const LICENSE = join(ROOT, 'compiler', 'LICENSE.md')           // Silicon MIT
const THIRD_PARTY = join(CLI, 'THIRD-PARTY-LICENSES.md')        // embedded Bun runtime

for (const p of [LICENSE, THIRD_PARTY]) {
    if (!existsSync(p)) { console.error(`missing license file: ${p}`); process.exit(1) }
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const plat of PLATFORMS) {
    const bin = join(DIST, `sgl-${plat}`)
    if (!existsSync(bin)) {
        console.error(`missing ${bin} — run cli/scripts/build-binary.ts first`)
        process.exit(1)
    }
    const name = `sgl-${VERSION}-${plat}`
    const stage = join(DIST, name)
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage)
    copyFileSync(bin, join(stage, 'sgl'))
    chmodSync(join(stage, 'sgl'), 0o755)
    copyFileSync(LICENSE, join(stage, 'LICENSE'))
    copyFileSync(THIRD_PARTY, join(stage, 'THIRD-PARTY-LICENSES.md'))

    const tarball = `${name}.tar.gz`
    await Bun.$`tar czf ${join(OUT, tarball)} -C ${DIST} ${name}`
    const listing = (await Bun.$`tar tzf ${join(OUT, tarball)}`.text()).trim().split('\n')
    for (const required of [`${name}/sgl`, `${name}/LICENSE`, `${name}/THIRD-PARTY-LICENSES.md`]) {
        if (!listing.includes(required)) {
            console.error(`release tarball missing ${required}`)
            process.exit(1)
        }
    }
    await Bun.$`sha256sum ${tarball} > ${`${tarball}.sha256`}`.cwd(OUT)
    if (!existsSync(join(OUT, `${tarball}.sha256`))) {
        console.error(`release checksum missing for ${tarball}`)
        process.exit(1)
    }
    rmSync(stage, { recursive: true, force: true })
    console.log(`✓ ${name}.tar.gz  (sgl + LICENSE + THIRD-PARTY-LICENSES.md)`)
}

console.log(`\nRelease assets in ${OUT}`)
