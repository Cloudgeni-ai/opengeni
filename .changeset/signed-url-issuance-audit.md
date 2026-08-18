---
"@opengeni/storage": patch
---

Every principal-facing signed object-storage URL issuance (file download/upload mints, video playback sources, document originals, the files-MCP download tool) now records a metadata-only audit fact - subject, target, expiry; never the URL or object key - before the bearer URL leaves the platform. The short default TTLs (download 300 s, upload 900 s) are pinned as the deliberate post-revocation residual window; worker- and provider-internal signed URLs keep their attempt/session-scoped authority unchanged.
