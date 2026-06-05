// SPDX-License-Identifier: MIT
// Silicon docs site (story 10c-10).  VitePress config.
//
// Why VitePress: TypeScript-native, ships with Pagefind-compatible
// search, supports the URL versioning we'll need for v1.x docs (the
// /v1.0/ vs /latest/ pattern), deploys to GitHub Pages out of the box.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Grammars are vendored alongside this config so the website is
// self-contained — no dependency on sibling repos / packages.
// Re-sync silicon.tmLanguage.json from plugins/vscode/syntaxes/ when
// the grammar changes. ebnf.tmLanguage.json is hand-maintained here:
// Shiki ships no EBNF grammar, so the synced docs/grammar.ebnf page
// would fall back to plain txt (with a build warning) without it.
const siliconGrammar = JSON.parse(
    readFileSync(resolve(__dirname, 'silicon.tmLanguage.json'), 'utf8')
)
const ebnfGrammar = JSON.parse(
    readFileSync(resolve(__dirname, 'ebnf.tmLanguage.json'), 'utf8')
)

export default defineConfig({
    title: 'Silicon',
    description: 'A WebAssembly-targeting systems language where features are data.',
    base: '/',
    lang: 'en-US',
    cleanUrls: true,
    lastUpdated: true,

    markdown: {
        languages: [
            { ...siliconGrammar, name: 'silicon', aliases: ['si'] },
            { ...ebnfGrammar, name: 'ebnf' },
        ],
    },
    // Synced docs (from repo docs/) carry relative links that point at
    // sibling repo files (ADRs, .wit, user-stories HTML) which don't
    // exist on the site.  We warn during sync and ignore at build.
    // External links and intra-site links still work.
    ignoreDeadLinks: true,

    head: [
        ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
        ['meta', { name: 'theme-color', content: '#6c8ef7' }],
    ],

    themeConfig: {
        logo: '/logo.svg',
        siteTitle: 'Silicon',

        nav: [
            { text: 'Get started', link: '/guide/getting-started' },
            { text: 'Reference', link: '/reference/' },
            { text: 'Examples', link: '/examples/' },
            { text: 'Playground', link: '/playground' },
            { text: 'Blog', link: '/blog/' },
            { text: 'Stability', link: '/stability/' },
            {
                text: 'v0.1',
                items: [
                    { text: 'Changelog', link: 'https://github.com/NatesCode/silicon/blob/main/CHANGELOG.md' },
                    { text: 'Security', link: '/stability/security' },
                    { text: 'Performance', link: '/stability/performance' },
                ],
            },
            { text: 'GitHub', link: 'https://github.com/NatesCode/silicon' },
        ],

        sidebar: {
            '/blog/': [
                {
                    text: 'Blog',
                    items: [
                        { text: 'All posts', link: '/blog/' },
                        { text: "Silicon's Publicly Released!", link: '/blog/silicon-alpha-1-release' },
                    ],
                },
            ],
            '/guide/': [
                {
                    text: 'Guide',
                    items: [
                        { text: 'Getting started', link: '/guide/getting-started' },
                        { text: 'Install', link: '/guide/install' },
                        { text: 'Language overview', link: '/guide/overview' },
                        { text: 'Standard library', link: '/guide/stdlib' },
                        { text: 'Language tour', link: '/guide/tour' },
                        { text: 'Writing a stratum', link: '/guide/strata' },
                        { text: 'Memory + arenas', link: '/guide/memory' },
                        { text: 'Native compilation', link: '/guide/native' },
                        { text: 'Platforms', link: '/guide/platforms' },
                    ],
                },
            ],
            '/reference/': [
                {
                    text: 'Language',
                    items: [
                        { text: 'Overview', link: '/reference/' },
                        { text: 'Grammar (EBNF)', link: '/reference/grammar' },
                        { text: 'Types', link: '/reference/types' },
                        { text: 'Type inference (HM-lite)', link: '/reference/hm-lite' },
                        { text: 'Diagnostics', link: '/reference/diagnostics' },
                    ],
                },
                {
                    text: 'Strata',
                    items: [
                        { text: 'Strata system', link: '/reference/strata' },
                        { text: 'Strata authoring', link: '/reference/strata-authoring' },
                        { text: 'Compiler API', link: '/reference/compiler-api' },
                    ],
                },
                {
                    text: 'CaaS',
                    items: [
                        { text: 'Compiler-as-a-Service', link: '/reference/caas' },
                        { text: 'API surface', link: '/reference/api' },
                        { text: 'API boundaries', link: '/reference/api-boundaries' },
                    ],
                },
            ],
            '/examples/': [
                {
                    text: 'Cookbook',
                    items: [
                        { text: 'Index', link: '/examples/' },
                        { text: 'Hello world', link: '/examples/hello' },
                        { text: 'Sum types + @match', link: '/examples/sum-types' },
                        { text: 'Generics', link: '/examples/generics' },
                        { text: 'Error handling with @try', link: '/examples/try' },
                        { text: 'Arena allocation', link: '/examples/arena' },
                        { text: 'Rc smart pointer', link: '/examples/rc' },
                        { text: 'Writing a stratum', link: '/examples/stratum' },
                        { text: 'Strata as design solvent', link: '/examples/dsl' },
                        { text: 'QBE native compile', link: '/examples/native' },
                        { text: 'First-class functions', link: '/examples/first-class-fns' },
                    ],
                },
            ],
            '/stability/': [
                {
                    text: 'Stability',
                    items: [
                        { text: 'Overview', link: '/stability/' },
                        { text: 'Language', link: '/stability/language' },
                        { text: 'CompilerAPI', link: '/stability/compiler-api' },
                        { text: 'Strata API', link: '/stability/strata-api' },
                        { text: 'ADRs', link: '/stability/adrs' },
                        { text: 'Security', link: '/stability/security' },
                        { text: 'Performance', link: '/stability/performance' },
                    ],
                },
            ],
        },

        socialLinks: [
            { icon: 'github', link: 'https://github.com/NatesCode/silicon' },
        ],

        editLink: {
            pattern: 'https://github.com/NatesCode/silicon/edit/main/website/src/:path',
            text: 'Edit this page on GitHub',
        },

        search: {
            // Pagefind would need a build hook; we use the built-in
            // local search at 1.0 since the corpus is small.
            provider: 'local',
            options: {
                detailedView: true,
            },
        },

        footer: {
            message: 'MIT-licensed. © 2024–2026 NatesCode LLC, Nathan Hedglin.',
            copyright: '<a href="https://github.com/NatesCode/silicon/issues/new">Report an issue</a>',
        },
    },
})
