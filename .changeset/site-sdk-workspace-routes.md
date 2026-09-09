---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/codemode": patch
"@opengeni/runtime": patch
---

Remove the Site SDK endpoint allowlist. Workspace API requests now reach ordinary authorization handlers in published Sites and sandbox previews; tenant routing, agent permission limits, and direct integration-tool checks remain unchanged. Clarify the distinction between authoring, preview, and viewer access in the Sites skill, including honest reporting of viewer-only verification.
