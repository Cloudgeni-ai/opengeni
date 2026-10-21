---
"@opengeni/events": patch
"@opengeni/api-router": patch
---

Use native Ed25519 for NATS authorization JWT signing and reuse the current signing seed's imported key. Preserve JWT bytes, seed validation, permissions, expiry, and key-rotation behavior while avoiding repeated pure-JavaScript key derivation and signing.
