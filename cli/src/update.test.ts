// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
    cmdUpdate,
    compareReleaseVersions,
    detectUpdatePlatform,
    installPolicyForExecutable,
    parseUpdateArgs,
    releaseAssetName,
} from './update'

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgl-update-test-'))
    try {
        await fn(dir)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

describe('sgl update helpers', () => {
    test('detects installer-compatible platform names', () => {
        expect(detectUpdatePlatform('linux', 'x64')).toBe('linux-x86_64')
        expect(detectUpdatePlatform('linux', 'arm64')).toBe('linux-aarch64')
        expect(detectUpdatePlatform('darwin', 'x64')).toBe('macos-x86_64')
        expect(detectUpdatePlatform('darwin', 'arm64')).toBe('macos-aarch64')
    })

    test('unsupported platforms error cleanly', () => {
        expect(() => detectUpdatePlatform('win32', 'x64')).toThrow('unsupported operating system')
        expect(() => detectUpdatePlatform('linux', 'riscv64')).toThrow('unsupported Linux architecture')
    })

    test('--version constructs expected release asset names', () => {
        const args = parseUpdateArgs(['--version', 'v1.2.3'])
        expect(args.version).toBe('v1.2.3')
        expect(releaseAssetName(args.version!, 'linux-x86_64')).toBe('sgl-v1.2.3-linux-x86_64.tar.gz')
    })

    test('same-version comparison is equal unless a newer patch exists', () => {
        expect(compareReleaseVersions('v1.2.3', '1.2.3')).toBe(0)
        expect(compareReleaseVersions('v1.2.4', '1.2.3')).toBe(1)
        expect(compareReleaseVersions('v1.2.2', '1.2.3')).toBe(-1)
    })

    test('manager-owned paths are delegated instead of overwritten', () => {
        const policy = installPolicyForExecutable('/usr/local/bin/sgl')
        expect(policy.ok).toBe(false)
        if (!policy.ok) expect(policy.message).toContain('rerun the installer')
    })
})

describe('sgl update command', () => {
    test('--check reports current/latest without resolving or replacing an executable', async () => {
        const output: string[] = []
        const fetchImpl = async (url: string) => {
            expect(url).toContain('/releases/latest')
            return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 })
        }
        await cmdUpdate({
            currentVersion: '0.1.0',
            args: ['--check'],
            fetchImpl,
            stdout: { write: (chunk: string) => { output.push(chunk); return true } },
        })
        expect(output.join('')).toContain('current v0.1.0, latest v9.9.9')
        expect(output.join('')).toContain('Update available')
    })

    test('same-version update exits cleanly unless --force', async () => {
        const output: string[] = []
        const fetchImpl = async () => new Response(JSON.stringify({ tag_name: 'v0.1.0' }), { status: 200 })
        await cmdUpdate({
            currentVersion: '0.1.0',
            args: [],
            fetchImpl,
            stdout: { write: (chunk: string) => { output.push(chunk); return true } },
        })
        expect(output.join('')).toContain('sgl is up to date')
    })

    test('checksum mismatch aborts before replacing the binary', async () => {
        await withTempDir(async dir => {
            const current = path.join(dir, 'sgl')
            fs.writeFileSync(current, '#!/bin/sh\necho "sgl v0.1.0"\n')
            fs.chmodSync(current, 0o755)
            const tarBytes = new TextEncoder().encode('not a tarball')
            const fetchImpl = async (url: string) => {
                if (url.endsWith('.sha256')) return new Response(`0000 ${path.basename(url, '.sha256')}\n`)
                if (url.includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v9.9.9' }))
                return new Response(tarBytes)
            }
            await expect(cmdUpdate({
                currentVersion: '0.1.0',
                args: [],
                fetchImpl,
                currentExecutable: current,
                stdout: { write: () => true },
                stderr: { write: () => true },
            })).rejects.toThrow('checksum mismatch')
            expect(fs.readFileSync(current, 'utf-8')).toContain('v0.1.0')
        })
    })

    test('local release fixture updates a scratch executable and copies licenses', async () => {
        await withTempDir(async dir => {
            const platform = detectUpdatePlatform()
            const version = 'v9.9.9'
            const current = path.join(dir, 'sgl')
            fs.writeFileSync(current, '#!/bin/sh\necho "sgl v0.1.0"\n')
            fs.chmodSync(current, 0o755)

            const stageRoot = path.join(dir, 'stage')
            const releaseDir = path.join(stageRoot, `sgl-${version}-${platform}`)
            fs.mkdirSync(releaseDir, { recursive: true })
            fs.writeFileSync(path.join(releaseDir, 'sgl'), '#!/bin/sh\necho "sgl v9.9.9"\n')
            fs.chmodSync(path.join(releaseDir, 'sgl'), 0o755)
            fs.writeFileSync(path.join(releaseDir, 'LICENSE'), 'MIT\n')
            fs.writeFileSync(path.join(releaseDir, 'THIRD-PARTY-LICENSES.md'), 'third party\n')
            const tarball = path.join(dir, releaseAssetName(version, platform))
            const tar = spawnSync('tar', ['czf', tarball, '-C', stageRoot, path.basename(releaseDir)], { encoding: 'utf-8' })
            expect(tar.status).toBe(0)
            const tarBytes = fs.readFileSync(tarball)
            const digest = crypto.createHash('sha256').update(tarBytes).digest('hex')
            const fetchImpl = async (url: string) => {
                if (url.includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: version }))
                if (url.endsWith('.sha256')) return new Response(`${digest} ${path.basename(tarball)}\n`)
                return new Response(tarBytes)
            }

            await cmdUpdate({
                currentVersion: '0.1.0',
                args: [],
                fetchImpl,
                currentExecutable: current,
                stdout: { write: () => true },
                stderr: { write: () => true },
            })

            expect(fs.readFileSync(current, 'utf-8')).toContain('v9.9.9')
            expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf-8')).toContain('MIT')
            expect(fs.readFileSync(path.join(dir, 'THIRD-PARTY-LICENSES.md'), 'utf-8')).toContain('third party')
        })
    })

    test('--version installs the requested tag even when it is older than current', async () => {
        await withTempDir(async dir => {
            const platform = detectUpdatePlatform()
            const version = 'v1.2.3'
            const current = path.join(dir, 'sgl')
            fs.writeFileSync(current, '#!/bin/sh\necho "sgl v9.9.9"\n')
            fs.chmodSync(current, 0o755)

            const stageRoot = path.join(dir, 'stage')
            const releaseDir = path.join(stageRoot, `sgl-${version}-${platform}`)
            fs.mkdirSync(releaseDir, { recursive: true })
            fs.writeFileSync(path.join(releaseDir, 'sgl'), '#!/bin/sh\necho "sgl v1.2.3"\n')
            fs.chmodSync(path.join(releaseDir, 'sgl'), 0o755)
            fs.writeFileSync(path.join(releaseDir, 'LICENSE'), 'MIT\n')
            fs.writeFileSync(path.join(releaseDir, 'THIRD-PARTY-LICENSES.md'), 'third party\n')
            const tarball = path.join(dir, releaseAssetName(version, platform))
            const tar = spawnSync('tar', ['czf', tarball, '-C', stageRoot, path.basename(releaseDir)], { encoding: 'utf-8' })
            expect(tar.status).toBe(0)
            const tarBytes = fs.readFileSync(tarball)
            const digest = crypto.createHash('sha256').update(tarBytes).digest('hex')
            const seenUrls: string[] = []
            const fetchImpl = async (url: string) => {
                seenUrls.push(url)
                if (url.endsWith('.sha256')) return new Response(`${digest} ${path.basename(tarball)}\n`)
                return new Response(tarBytes)
            }

            await cmdUpdate({
                currentVersion: '9.9.9',
                args: ['--version', version],
                fetchImpl,
                currentExecutable: current,
                stdout: { write: () => true },
                stderr: { write: () => true },
            })

            expect(seenUrls.some(url => url.includes('/releases/latest'))).toBe(false)
            expect(seenUrls.join('\n')).toContain(releaseAssetName(version, platform))
            expect(fs.readFileSync(current, 'utf-8')).toContain('v1.2.3')
        })
    })
})
