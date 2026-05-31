# Homebrew Formula

The `sgl.rb` formula is the template used to publish to the
`natescode/homebrew-sigil` tap.

## Usage (once the tap is published)

```sh
brew tap natescode/sigil
brew install sgl
```

## Updating for a new release

1. Update `version` in `sgl.rb`.
2. Replace the four `PLACEHOLDER_*_SHA256` values with the actual SHA-256
   checksums from the GitHub Release (found in the `.sha256` files).
3. Open a PR against the tap repository (`natescode/homebrew-sigil`).

The release workflow in `.github/workflows/release.yml` prints checksums
to the release notes automatically.
