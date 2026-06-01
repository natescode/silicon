// SPDX-License-Identifier: MIT
// Silicon blog — VitePress config. Mirrors the docs site setup so the two
// deploy the same way (static, domain root). Posts live in src/posts/*.md.
import { defineConfig } from 'vitepress'

export default defineConfig({
    title: 'Silicon Blog',
    description: 'News and writing about the Silicon programming language.',
    base: '/',
    lang: 'en-US',
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: true,

    head: [
        ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
        ['meta', { name: 'theme-color', content: '#6c8ef7' }],
    ],

    themeConfig: {
        siteTitle: 'Silicon Blog',
        nav: [
            { text: 'Posts', link: '/' },
            { text: 'Docs', link: 'https://si14.dev' },
            { text: 'Playground', link: 'https://playground.si14.dev' },
            { text: 'GitHub', link: 'https://github.com/NatesCode/silicon' },
        ],
        sidebar: [
            {
                text: 'Posts',
                items: [
                    { text: 'Announcing Silicon Alpha 1.0', link: '/posts/alpha-1-0-announcement' },
                    { text: "Silicon's Publicly Released!", link: '/posts/silicon-alpha-1-release' },
                ],
            },
        ],
        socialLinks: [
            { icon: 'github', link: 'https://github.com/NatesCode/silicon' },
        ],
        footer: {
            message: 'MIT-licensed. © 2024–2026 NatesCode LLC, Nathan Hedglin.',
            copyright: '<a href="https://github.com/NatesCode/silicon/issues/new">Report an issue</a>',
        },
    },
})
