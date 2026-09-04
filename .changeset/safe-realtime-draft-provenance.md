---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Preserve newer composer draft content and project provenance when a stale realtime create records selection history, while exposing optional project provenance consistently across contracts and SDK types. Store project provenance in rolling-upgrade-safe additive draft columns behind a metadata fence, concurrent partial index, bounded resumable backfill, and separately committed validation; dual-write mixed-version draft writers without holding schema locks across legacy-row scans. Avoid passive hydration autosaves and honor the latest route launch intent when hydration completes.
