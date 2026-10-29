---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Secret-shaped strings in tool output are masked. High-precision detectors find URL passwords (any scheme), connection-string passwords, Azure account keys, shared access keys and SAS signatures, PEM private keys and well-known token formats (GitHub, OpenAI, Anthropic, Slack, Stripe, npm, GitLab, Google, 1Password, Opengeni bearers, JWTs), and replace only the secret part. Each value is captured into the root session's Task vault under a stable keyed-HMAC item name and replaced by its reference, so the agent can keep using it without seeing it; when capture is not possible a `[masked <kind>]` marker is written and the tool call still succeeds. The detectors (`detectSecretShapes`, `maskSecretShapes`, `maskSecretShapesInText`, `collectSecretShapes`) are exported from `@opengeni/contracts`.
