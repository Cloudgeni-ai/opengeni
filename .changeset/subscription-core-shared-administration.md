---
"@opengeni/db": patch
---

Move subscription account administration onto the shared provider-neutral core. Account pools, primary account, rotation, workspace source, allocator, extra credits, rename, connect, disconnect and catalog readiness now take the provider as data, and Codex keeps its existing functions, shapes and messages as thin wrappers.
