---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/documents": patch
"@opengeni/events": patch
"@opengeni/github": patch
"@opengeni/storage": patch
---

Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
