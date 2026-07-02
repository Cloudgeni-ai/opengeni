---
"@opengeni/worker-bundle": patch
---

`createOpenGeniWorker` accepts an optional `workflowsPath` so embedded hosts can point Temporal's workflow bundler at a relocated copy of `workflows.ts` — the in-package default under `node_modules` is not transpiled by Temporal's webpack. Standalone behavior is unchanged when unset.
