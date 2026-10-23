---
"@opengeni/sdk": patch
---

`createEventSource({ kind: "github" })` now adds the workspace's GitHub event source: automations can trigger on pull requests, reviews, comments, issues, pushes, releases and CI results from the repositories the workspace is connected to. GitHub App manifests for public deployments now include the webhook and these events.
