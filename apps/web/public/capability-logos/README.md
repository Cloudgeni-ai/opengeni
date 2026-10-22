# First-party capability marks

These bundled marks cover first-party catalog rows that do not pass
through the integrations.sh import, so they cannot receive a vendored registry
`logoAssetPath`. `@opengeni/react` carries them as data URLs (generated from
these files; a test keeps them identical), so the session UI shows them in
every host. It never hotlinks a provider or relies on a third-party host at
runtime.

`manifest.json` records the exact product identity, source, licence posture,
and any display-only modification. The marks remain property of their owners
and are reproduced only to identify the corresponding connector. A missing or
invalid asset still falls back to the ordinary catalog monogram.

Keep this set deliberately small. Registry connectors belong in
`data/catalog/logos/` and are regenerated through `bun run
catalog:vendor-logos`; do not mirror the long tail here.
