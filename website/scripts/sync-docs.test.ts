// SPDX-License-Identifier: MIT
/**
 * Unit tests for the docs→site link rewriter in sync-docs.ts.
 *
 * Repo docs link relatively to docs/.  On the site those must become intra-site
 * routes (for docs that are themselves synced) or absolute GitHub URLs (for repo
 * files the site doesn't host) — while code spans and external links are left
 * alone.  These tests lock that behaviour.
 */
import { test, expect, describe } from 'bun:test'
import { renderSyncBody, rewriteLinks } from './sync-docs'

// All links below originate from a doc at docs/<x>.md (so docs-relative).
const from = 'docs/overview.md'
const rw = (md: string) => rewriteLinks(md, from)

describe('sync-docs link rewriting', () => {
    test('link to a synced doc → intra-site route', () => {
        // docs/targets.md is synced to guide/platforms.md
        expect(rw('see [Platforms](targets.md)')).toBe('see [Platforms](/guide/platforms)')
        // docs/hm-lite.md → reference/hm-lite.md, anchor preserved
        expect(rw('[inf](hm-lite.md#instantiation)')).toBe('[inf](/reference/hm-lite#instantiation)')
        expect(rw('[asi](automatic-semicolon-insertion.html)'))
            .toBe('[asi](/reference/automatic-semicolon-insertion)')
    })

    test('link to a repo file the site does NOT host → absolute GitHub URL', () => {
        expect(rw('[js](js-string-builtins.md)'))
            .toBe('[js](https://github.com/NatesCode/silicon/blob/main/docs/js-string-builtins.md)')
    })

    test('link to an ADR / sibling-repo path → GitHub URL', () => {
        expect(rw('[adr](adr/0008-memory-management-arenas.md)'))
            .toBe('[adr](https://github.com/NatesCode/silicon/blob/main/docs/adr/0008-memory-management-arenas.md)')
    })

    test('external links, anchors, and images are left untouched', () => {
        expect(rw('[gh](https://github.com/x)')).toBe('[gh](https://github.com/x)')
        expect(rw('[top](#section)')).toBe('[top](#section)')
        expect(rw('![diagram](targets.md)')).toBe('![diagram](targets.md)')  // image src untouched
    })

    test('inline code is protected (a [x](y)-shaped expression in backticks is not a link)', () => {
        const code = 'call `instance.exports[name](handle)` to run it'
        expect(rw(code)).toBe(code)
    })

    test('a link whose LABEL contains inline code is still rewritten', () => {
        expect(rw('[`targets.md`](targets.md)')).toBe('[`targets.md`](/guide/platforms)')
    })

    test('fenced code blocks are left untouched', () => {
        const fenced = ['```md', '[x](targets.md)', '```'].join('\n')
        expect(rw(fenced)).toBe(fenced)
    })

    test('raw sync mode copies HTML without markdown rewriting', () => {
        const html = '<a href="targets.md">repo-relative stays raw</a>'
        expect(renderSyncBody({
            from: 'docs/automatic-semicolon-insertion.html',
            to: 'public/reference/automatic-semicolon-insertion.html',
            mode: 'raw',
        }, html)).toBe(html)
    })
})
