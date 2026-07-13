# Release contracts

This directory contains provider-neutral metadata consumed by external release
operators. It contains no environment names, credentials, registry locations,
or Cloudgeni-specific policy.

## Migration compatibility

`migration-contracts.json` is a cumulative array with one retained entry for
every migration that may be introduced through the automatic rollback-safe
path. The external operator selects the entries that are new relative to its
last-known-good source revision:

```json
{
  "migration": "0049_example.sql",
  "phase": "expand",
  "previousCodeCompatible": true,
  "previousReaderCompatible": true,
  "previousWriterCompatible": true,
  "rollbackMode": "code-only"
}
```

The automatic release path accepts only `expand` migrations that preserve the
previous code's reads and writes and permit code-only rollback. A `contract`
migration or `schema-restore-required` rollback mode must be delivered as a
separate, explicitly reviewed maintenance operation after the replacement path
has production evidence. Historical SQL migrations are immutable; modifying or
removing one is always a release error. The operator retains the
last-known-good SQL-byte manifest and complete metadata array, requires every
candidate array to be an exact superset of the previously recorded entries,
and compares the bytes at both source revisions. Deleting an old metadata entry
can never make its migration disappear from compatibility review.

This metadata is an assertion that must be backed by mixed old/new-worker and
migration tests. It does not make an incompatible migration safe.

## Single runtime publisher

The app repository's `.github/workflows/release.yml` is changesets/npm-only.
It must never push the Helm chart or API, worker, web, or relay images: a
sequential legacy publisher can expose a partial public set after cancellation
or one failed image push, outside the durable release ledger. The external
operator must accept one complete SHA/digest/provenance set, pass staging, and
promote that identical accepted set without rebuilding. CI enforces this
boundary with `scripts/check-single-release-publisher.ts` and one regression
for the chart plus every runtime image. Public GHCR chart/image publication is
therefore intentionally disabled until the external operator owns a reviewed
complete-set publication step after digest acceptance; npm publication and the
independent signed Rust-agent GitHub Release channel remain available.