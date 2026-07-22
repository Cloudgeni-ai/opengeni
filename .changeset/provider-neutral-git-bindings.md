---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/runtime": minor
"@opengeni/worker-bundle": minor
---

Support mixed GitHub, GitLab, and Azure DevOps repositories—including multiple
accounts or installations for one provider—in a single session through bounded,
host-opaque credential bindings and optional read/write access intent.

Validate binding/provider/host echoes before token injection, isolate tokens in
hashed binding files, select Git credentials by remote path, fail provider CLIs
closed on ambiguous bindings, and renew each binding independently while keeping
legacy one-binding-per-provider request and file aliases compatible.
