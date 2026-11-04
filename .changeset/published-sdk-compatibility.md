---
"@opengeni/sdk": patch
"@opengeni/api-router": patch
"@opengeni/observability": patch
---

Keep supported published SDKs working against the current hosted API with a
deterministic integration matrix and prevent silently removing tested versions.
SDK requests identify their package version for content-free request diagnostics;
the optional header never changes authorization or compatibility admission.
