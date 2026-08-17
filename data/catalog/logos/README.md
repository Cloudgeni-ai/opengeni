# Vendored connector logos

These files are third-party vendor marks, committed so a default deployment can
show connector logos without fetching from third-party logo hosts at deploy
time. They are **not** covered by this repository's licence and are not
OpenGeni's to relicense. Each mark remains the property of its owner and is
reproduced here solely to identify that owner's product in the connector
catalog, which is nominative use.

## What is here

- `manifest.json` - provenance for every asset: the registry capability id, the
  provider domain and canonical MCP URL it was vendored for, the exact logo
  source URL at vendoring time, the SHA-256 digest, content type, byte size, and
  fetch timestamp. It is the authority; a file with no entry is an orphan and
  the vendoring script deletes it.
- One asset file per curated connector that publishes a reusable mark.

## Rules

- Do not add, edit, or delete files here by hand. Run
  `bun run catalog:vendor-logos`, which refetches from the current snapshot plus
  the curated overlay, validates, and rewrites both the assets and the manifest.
- Only curated rows are vendored. The uncurated long tail keeps a monogram
  unless a deployment opts into logo fetching.
- A curated `logoSourceUrl: null` in `data/catalog/curated.json` suppresses the
  logo entirely. Use it when a provider publishes no reusable mark, as with
  Gmail and Mobbin today. That decision belongs in the overlay, never here.
- The importer refuses an asset whose bytes no longer match its manifest digest,
  whose row moved to a different logo source, whose content type the
  catalog-asset route cannot serve, or, for SVG, that carries active content.
  Any of those degrades that one row to a monogram; it never fails the import.

## Removing a mark

If a vendor asks that their mark not be redistributed, set `logoSourceUrl` to
`null` for that row in `data/catalog/curated.json` and rerun
`bun run catalog:vendor-logos`. That removes the asset and its manifest entry,
and the row falls back to a monogram.
