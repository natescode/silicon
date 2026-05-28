// SPDX-License-Identifier: MIT
/**
 * Sync `../docs/*.md` (the repo's source-of-truth docs) into the
 * VitePress site (story 10c-10).
 *
 * Repo docs/ stays authoritative; site/src/ is a render target.  Run
 * `bun run sync` before `bun run build` or wire it into the build step
 * if you want a one-command flow.
 *
 * The mapping is explicit (no glob), so adding a new doc page is a
 * deliberate act and the site IA doesn't drift silently with repo
 * additions.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SITE_SRC = join(import.meta.dirname, '..', 'src')

interface Sync {
    from: string  // relative to REPO_ROOT
    to: string    // relative to SITE_SRC
    /** Optional frontmatter to prepend (title etc). */
    frontmatter?: Record<string, string>
}

const SYNCS: Sync[] = [
    // Guide
    { from: 'docs/getting-started.md',         to: 'guide/getting-started.md', frontmatter: { title: 'Getting started' } },
    { from: 'docs/memory.md',                  to: 'guide/memory.md',          frontmatter: { title: 'Memory + arenas' } },
    { from: 'docs/strata-authoring-guide.md',  to: 'guide/strata.md',          frontmatter: { title: 'Writing a stratum' } },

    // Reference
    { from: 'docs/grammar.ebnf',               to: 'reference/grammar.md',     frontmatter: { title: 'Grammar (EBNF)' } },
    { from: 'docs/hm-lite.md',                 to: 'reference/hm-lite.md',     frontmatter: { title: 'Type inference (HM-lite)' } },
    { from: 'docs/diagnostics.md',             to: 'reference/diagnostics.md', frontmatter: { title: 'Diagnostics' } },
    { from: 'docs/strata.md',                  to: 'reference/strata.md',      frontmatter: { title: 'Strata system' } },
    { from: 'docs/strata-authoring-guide.md',  to: 'reference/strata-authoring.md', frontmatter: { title: 'Strata authoring guide' } },
    { from: 'docs/compiler-api.md',            to: 'reference/compiler-api.md', frontmatter: { title: 'Compiler API' } },
    { from: 'docs/compiler-as-a-service.md',   to: 'reference/caas.md',        frontmatter: { title: 'Compiler-as-a-Service' } },
    { from: 'docs/api-boundaries.md',          to: 'reference/api-boundaries.md', frontmatter: { title: 'API boundaries' } },
    { from: 'etc/sigil.api.md',                to: 'reference/api.md',         frontmatter: { title: 'CaaS API surface' } },

    // Stability
    { from: 'docs/stability.md',               to: 'stability/index.md',       frontmatter: { title: 'Stability' } },
    { from: 'docs/security.md',                to: 'stability/security.md',    frontmatter: { title: 'Security' } },
    { from: 'docs/performance.md',             to: 'stability/performance.md', frontmatter: { title: 'Performance' } },
]

function toFrontmatter(fm: Record<string, string>): string {
    const lines = ['---']
    for (const [k, v] of Object.entries(fm)) {
        lines.push(`${k}: ${JSON.stringify(v)}`)
    }
    lines.push('---', '')
    return lines.join('\n')
}

function sync(s: Sync): void {
    const fromPath = join(REPO_ROOT, s.from)
    const toPath = join(SITE_SRC, s.to)
    let body: string
    try {
        body = readFileSync(fromPath, 'utf-8')
    } catch (e) {
        console.warn(`skip ${s.from} (not found)`)
        return
    }

    // EBNF files: wrap in a fence block so they render as code.
    if (s.from.endsWith('.ebnf')) {
        body = '```ebnf\n' + body + '\n```\n'
    }

    // Strip any SPDX header in the source — distracts in rendered docs.
    body = body.replace(/^(\/\/|#) SPDX-License-Identifier: MIT\n/, '')

    const out = (s.frontmatter ? toFrontmatter(s.frontmatter) : '') + body
    mkdirSync(dirname(toPath), { recursive: true })
    writeFileSync(toPath, out, 'utf-8')
    console.log(`synced ${s.from} → site/src/${s.to}`)
}

for (const s of SYNCS) sync(s)
console.log(`\n${SYNCS.length} files synced.`)
