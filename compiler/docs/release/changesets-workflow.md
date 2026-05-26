# Changesets workflow for Sigil 1.0 → 1.1

Sigil uses [Changesets](https://github.com/changesets/changesets) to manage
versioning and changelog generation across the 1.0 → 1.1 release cycle.

Hand-curated entries — **not** auto-generated from commit messages or PR
titles. The trade-off:

| What we gain | What we give up |
|--------------|-----------------|
| Each changelog line is reader-facing prose, not "fix: typo (#321)" | Authors must remember to add a changeset; CI nags if they don't |
| Surface impact is rated by the author at the moment of the change | No fully-automatic changelog from `git log` |

## When to add a changeset

Add one whenever a PR is observable to a downstream consumer of Sigil:

| Change | Bump |
|--------|------|
| Public CaaS API addition (new exported function/type) | minor |
| `wit/comptime.wit` change visible to handler authors | minor |
| Bug fix that changes runtime behavior | patch |
| Breaking change to the public API or comptime ABI | major |
| Internal refactor with no observable effect | no changeset |
| New ADR with no implementation yet | no changeset |
| Documentation-only change | no changeset (unless behavior was undocumented before) |

When in doubt, add one — empty changelog entries are free; missing ones
cost users.

## Author flow

```sh
# After making your change, before opening the PR:
npx changeset

# Pick the bump level when prompted.
# Write the prose entry — it lands verbatim in CHANGELOG.md, so make it
# something you'd want to read as a user.

# The tool creates .changeset/<random-slug>.md.
# Commit it with your change.
git add .changeset/
git commit -m "..."
```

A reviewer sees your changeset in the PR diff. If they think the bump level
or wording is wrong, they comment on that file specifically — no separate
release-notes review pass.

## Release flow

When we cut a release:

```sh
# 1. Aggregate all unreleased changesets into a version bump + CHANGELOG.md.
npm run version
git commit -am "Release X.Y.Z"

# 2. Refresh the public API surface contract.
npm run api:extract
git commit -am "Refresh etc/sigil.api.md for X.Y.Z" # if there's drift

# 3. Publish (requires npm auth). The release script reruns api:extract first
#    as a safety check.
npm run release
```

`npm run release` runs api-extractor first to ensure
`etc/sigil.d.ts` matches `src/`. If api-extractor reports drift, fix it
before publishing — the rolled-up surface is the contract.

## Conventional commits

We deliberately do **not** use Conventional Commits. Reasons:

- Author-time prose is more useful than commit-message archaeology.
- Conventional Commits couple commit hygiene to changelog wording — we want
  these decoupled.
- Hand-curated entries naturally group related commits in one prose
  paragraph (e.g., "Phase 5 stdlib: Option/Result/u8-u64 + 34 tests" reads
  better than 12 separate `feat: …` lines).

This is recorded in case a future contributor proposes the change.

## CI nag (TODO)

A future CI step should fail any PR that:

- Modifies `src/` AND has no `.changeset/*.md` file added in the same PR,
  unless the PR description includes `[skip-changeset]`.

Tracked as story R-1.

## See also

- [Changesets docs](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)
- `docs/stability.md` — what the 1.0 stability contract guarantees
- `docs/adr/0005-no-js-collections-in-public-types.md` — example of a surface
  change that needs a `minor` changeset
- `etc/sigil.api.md` — the rolled-up API report; diff this to sanity-check
  the bump level before adding a changeset
