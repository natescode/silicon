// SPDX-License-Identifier: MIT

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

export const DEFAULT_RELEASE_REPO = 'natescode/silicon'
export const RELEASE_PLATFORMS = ['linux-x86_64', 'linux-aarch64', 'macos-x86_64', 'macos-aarch64'] as const
export type ReleasePlatform = typeof RELEASE_PLATFORMS[number]

export interface UpdateArgs {
    check: boolean
    force: boolean
    version?: string
}

export interface UpdateOptions {
    currentVersion: string
    args: string[]
    env?: NodeJS.ProcessEnv
    currentExecutable?: string
    stdout?: Pick<NodeJS.WriteStream, 'write'>
    stderr?: Pick<NodeJS.WriteStream, 'write'>
    fetchImpl?: typeof fetch
}

export function parseUpdateArgs(args: string[]): UpdateArgs {
    const parsed: UpdateArgs = { check: false, force: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--check') {
            parsed.check = true
        } else if (arg === '--force') {
            parsed.force = true
        } else if (arg === '--version') {
            const next = args[++i]
            if (!next) throw new Error('sgl update: --version requires a release tag')
            parsed.version = next
        } else if (arg.startsWith('--version=')) {
            parsed.version = arg.slice('--version='.length)
            if (!parsed.version) throw new Error('sgl update: --version requires a release tag')
        } else {
            throw new Error(`sgl update: unknown flag '${arg}'`)
        }
    }
    return parsed
}

export function detectUpdatePlatform(platform = process.platform, arch = process.arch): ReleasePlatform {
    if (platform === 'linux') {
        if (arch === 'x64') return 'linux-x86_64'
        if (arch === 'arm64') return 'linux-aarch64'
        throw new Error(`sgl update: unsupported Linux architecture: ${arch}`)
    }
    if (platform === 'darwin') {
        if (arch === 'x64') return 'macos-x86_64'
        if (arch === 'arm64') return 'macos-aarch64'
        throw new Error(`sgl update: unsupported macOS architecture: ${arch}`)
    }
    throw new Error(`sgl update: unsupported operating system: ${platform}`)
}

export function normalizeReleaseTag(version: string): string {
    return version.startsWith('v') ? version : `v${version}`
}

export function releaseAssetName(versionTag: string, platform: ReleasePlatform): string {
    return `sgl-${versionTag}-${platform}.tar.gz`
}

export function compareReleaseVersions(a: string, b: string): number {
    const parse = (value: string): number[] =>
        value.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
    const av = parse(a)
    const bv = parse(b)
    for (let i = 0; i < 3; i++) {
        if (av[i] > bv[i]) return 1
        if (av[i] < bv[i]) return -1
    }
    return 0
}

export function resolveCurrentExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const candidates: string[] = []
    if (env.SGL_UPDATE_CURRENT_EXE) candidates.push(env.SGL_UPDATE_CURRENT_EXE)
    if (path.basename(process.execPath).replace(/\.exe$/, '') === 'sgl') candidates.push(process.execPath)
    if (path.basename(process.argv[0]).replace(/\.exe$/, '') === 'sgl') candidates.push(process.argv[0])
    if (env.SGL_INSTALL_DIR) candidates.push(path.join(env.SGL_INSTALL_DIR, executableName()))

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
        } catch {
            // Try the next candidate.
        }
    }
    return undefined
}

export function installPolicyForExecutable(executable: string): { ok: true } | { ok: false, message: string } {
    const normalized = path.resolve(executable)
    const dir = path.dirname(normalized)
    const homeSgl = path.join(os.homedir(), '.sgl', 'bin')
    if (dir === homeSgl) return { ok: true }

    const lower = normalized.toLowerCase()
    if (
        lower.includes('/cellar/') ||
        lower.startsWith('/opt/homebrew/') ||
        lower.startsWith('/home/linuxbrew/.linuxbrew/') ||
        dir === '/usr/bin' ||
        dir === '/usr/local/bin'
    ) {
        return { ok: false, message: managerHint(normalized) }
    }

    try {
        fs.accessSync(normalized, fs.constants.W_OK)
        fs.accessSync(dir, fs.constants.W_OK)
    } catch {
        return { ok: false, message: managerHint(normalized) }
    }
    return { ok: true }
}

export async function cmdUpdate(options: UpdateOptions): Promise<void> {
    const env = options.env ?? process.env
    const stdout = options.stdout ?? process.stdout
    const stderr = options.stderr ?? process.stderr
    const fetchImpl = options.fetchImpl ?? fetch
    const args = parseUpdateArgs(options.args)
    const repo = env.SGL_REPO || DEFAULT_RELEASE_REPO
    const platform = detectUpdatePlatform()
    const currentTag = normalizeReleaseTag(options.currentVersion)
    const latestTag = args.version ? normalizeReleaseTag(args.version) : await fetchLatestReleaseTag(repo, fetchImpl)

    stdout.write(`sgl update: current ${currentTag}, latest ${latestTag}\n`)
    if (args.check) {
        stdout.write(compareReleaseVersions(latestTag, currentTag) > 0 ? 'Update available.\n' : 'sgl is up to date.\n')
        return
    }

    const versionComparison = compareReleaseVersions(latestTag, currentTag)
    if (args.version && !args.force && versionComparison === 0) {
        stdout.write('sgl is up to date. Use `sgl update --force` to reinstall this release.\n')
        return
    }
    if (!args.version && !args.force && versionComparison <= 0) {
        stdout.write('sgl is up to date. Use `sgl update --force` to reinstall this release.\n')
        return
    }

    const executable = options.currentExecutable ?? resolveCurrentExecutable(env)
    if (!executable) {
        throw new Error('sgl update: could not resolve the current sgl executable; set SGL_INSTALL_DIR to the install directory')
    }
    const policy = installPolicyForExecutable(executable)
    if (!policy.ok) {
        stderr.write(policy.message + '\n')
        return
    }

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-update-'))
    try {
        const tarball = await downloadReleaseTarball(repo, latestTag, platform, tmpDir, fetchImpl)
        await extractTarball(tarball, tmpDir)
        const releaseDir = path.join(tmpDir, `sgl-${latestTag}-${platform}`)
        const extracted = path.join(releaseDir, executableName())
        validateExtractedBinary(extracted)
        await replaceExecutableAtomically(extracted, executable)
        await copyLicenses(releaseDir, path.dirname(executable))
        stdout.write(`sgl ${latestTag} installed to ${executable}\n`)
    } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true })
    }
}

async function fetchLatestReleaseTag(repo: string, fetchImpl: typeof fetch): Promise<string> {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`)
    if (!response.ok) throw new Error(`sgl update: could not resolve latest release (${response.status})`)
    const data = await response.json() as { tag_name?: string }
    if (!data.tag_name) throw new Error('sgl update: latest release response did not include tag_name')
    return normalizeReleaseTag(data.tag_name)
}

async function downloadReleaseTarball(
    repo: string,
    versionTag: string,
    platform: ReleasePlatform,
    tmpDir: string,
    fetchImpl: typeof fetch,
): Promise<string> {
    const asset = releaseAssetName(versionTag, platform)
    const url = `https://github.com/${repo}/releases/download/${versionTag}/${asset}`
    const tarPath = path.join(tmpDir, asset)
    const shaPath = `${tarPath}.sha256`
    const [tarBytes, shaText] = await Promise.all([
        fetchBytes(url, fetchImpl),
        fetchText(`${url}.sha256`, fetchImpl),
    ])
    await fsp.writeFile(tarPath, tarBytes)
    await fsp.writeFile(shaPath, shaText)
    const expected = shaText.trim().split(/\s+/)[0]
    const actual = crypto.createHash('sha256').update(tarBytes).digest('hex')
    if (!expected || actual !== expected) {
        throw new Error(`sgl update: checksum mismatch for ${asset}\n  Expected: ${expected}\n  Got:      ${actual}`)
    }
    return tarPath
}

async function fetchBytes(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`sgl update: download failed (${response.status}) ${url}`)
    return new Uint8Array(await response.arrayBuffer())
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`sgl update: download failed (${response.status}) ${url}`)
    return await response.text()
}

async function extractTarball(tarball: string, tmpDir: string): Promise<void> {
    const result = spawnSync('tar', ['xzf', tarball, '-C', tmpDir], { encoding: 'utf-8' })
    if (result.status !== 0) {
        throw new Error(`sgl update: failed to extract release tarball\n${result.stderr ?? ''}`.trim())
    }
}

function validateExtractedBinary(binary: string): void {
    if (!fs.existsSync(binary)) throw new Error(`sgl update: release tarball did not contain ${path.basename(binary)}`)
    fs.chmodSync(binary, 0o755)
    const result = spawnSync(binary, ['version'], { encoding: 'utf-8' })
    if (result.status !== 0 || !result.stdout.includes('sgl ')) {
        throw new Error('sgl update: downloaded binary failed validation')
    }
}

async function replaceExecutableAtomically(source: string, destination: string): Promise<void> {
    const tmp = path.join(path.dirname(destination), `.sgl-update-${process.pid}-${Date.now()}`)
    await fsp.copyFile(source, tmp)
    await fsp.chmod(tmp, 0o755)
    await fsp.rename(tmp, destination)
}

async function copyLicenses(releaseDir: string, installDir: string): Promise<void> {
    for (const name of ['LICENSE', 'THIRD-PARTY-LICENSES.md']) {
        const src = path.join(releaseDir, name)
        if (!fs.existsSync(src)) continue
        try {
            await fsp.copyFile(src, path.join(installDir, name))
        } catch {
            // License copies are best-effort; the binary replacement is the critical path.
        }
    }
}

function managerHint(executable: string): string {
    const lower = executable.toLowerCase()
    if (lower.includes('/homebrew/') || lower.includes('/cellar/')) {
        return 'sgl update: this sgl appears to be managed by Homebrew; run `brew upgrade sgl` instead.'
    }
    if (lower.startsWith('/usr/bin')) {
        return 'sgl update: this sgl appears to be system-managed; run your OS package manager, for example `sudo apt upgrade sgl`.'
    }
    if (lower.startsWith('/usr/local/bin')) {
        return 'sgl update: this sgl is in /usr/local/bin; rerun the installer or download a release instead of overwriting it in place.'
    }
    return 'sgl update: this install location is not writable; rerun the installer, download a release, or use your package manager.'
}

function executableName(): string {
    return os.platform() === 'win32' ? 'sgl.exe' : 'sgl'
}
