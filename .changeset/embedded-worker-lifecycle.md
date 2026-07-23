---
"@opengeni/worker-bundle": minor
---

Ship a release-coherent pre-bundled Temporal workflow artifact and expose a
role-aware embedded worker lifecycle with health, readiness, metrics, internal
schedule ownership, and graceful drain. Installed hosts no longer relocate raw
workflow TypeScript out of `node_modules`.

Existing lower-level `createOpenGeniWorker` callers should remove copied-source
`workflowsPath` configuration. Installed control workers use the packaged
artifact automatically; an explicitly version-bound artifact may be supplied as
`workflowBundle`. Turn workers reject that control-only override.
