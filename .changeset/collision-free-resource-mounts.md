---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/config": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Make repository mount paths provider-neutral and collision-free. Omitted paths
now resolve to a canonical host-aware default that distinguishes GitHub,
GitLab, Azure DevOps, and custom hosts, while one shared portable-path validator
rejects traversal and case-folded collisions before sandbox execution.

Hosts upgrading sessions persisted without `mountPath` should expect those
repositories to materialize at the new host-aware location. To preserve an
existing warm workspace location, stamp the session's former effective
`repos/<owner>/<repo>` path explicitly before upgrading. Previously accepted
explicit paths that are non-portable or collide after Unicode normalization and
case folding now fail validation and must be renamed.
