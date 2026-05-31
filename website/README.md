# site/

VitePress source for the Silicon documentation site (story 10c-10).

## Local dev

```sh
bun install
bun run sync         # pull docs/*.md from the repo into site/src/
bun run dev          # http://localhost:5173
bun run build        # site/src/.vitepress/dist
bun run preview      # serve the built site
```

## Architecture

- `src/index.md` — landing page (hero + features).
- `src/.vitepress/config.ts` — VitePress config (nav, sidebar, search).
- `src/guide/`, `src/reference/`, `src/examples/`, `src/stability/`
  — content pages.
- `scripts/sync-docs.ts` — pulls the source-of-truth `docs/*.md` from
  the repo into the site, with a frontmatter title. Repo `docs/` stays
  authoritative; this directory is a render target.

## Adding a new page

1. Write Markdown under `src/<section>/<slug>.md` with frontmatter:
   ```md
   ---
   title: My new page
   ---
   ```
2. Add a sidebar entry in `src/.vitepress/config.ts`.
3. If the page mirrors a `docs/*.md`, add a row to the `SYNCS` table
   in `scripts/sync-docs.ts` so future edits flow automatically.

## Deployment

`.github/workflows/docs.yml` builds and deploys on every push to
`main` that touches `docs/`, `etc/sigil.api.md`, `site/`, or the
workflow itself. The site is hosted on GitHub Pages.

Production base path: `/sigil/` (override with the
`SILICON_DOCS_BASE` env var if you fork or re-host).

## URL versioning

The base path is parameterised so `/v1.0/` vs `/latest/` can live
side-by-side once v1.x lands. At 1.0 only one version exists; the
config supports the second version landing without an IA change.

## Why VitePress

- TypeScript-native, ships with sensible defaults
- Built-in local search (Pagefind-style, no third-party crawler)
- First-class GitHub Pages deploy
- Markdown is the input — the in-repo `docs/` corpus is already there
- Theming we can override but don't need to at 1.0

Alternatives considered: Astro Starlight (heavier), Docusaurus (React +
Yarn + heavier), mdBook (Rust toolchain dependency).
