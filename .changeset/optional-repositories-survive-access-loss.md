---
"@opengeni/github": minor
"@opengeni/runtime": minor
"@opengeni/react": patch
---

An automatically attached (optional) repository that loses access after a task started no longer fails the task's later turns. Before the strict per-turn GitHub App allowlist recheck and installation-token mint, the worker drops, for that turn only, each optional repository the workspace allowlist no longer admits or the GitHub App installation can no longer reach, and reports it as `skippedOptionalRepositories` on a `sandbox.operation.completed` event named `optional-repository-access`. It only ever removes repositories; explicitly attached repositories keep the strict behavior.

Optional repository clones are also bounded (60 seconds each, 90 seconds together) when the sandbox has a `timeout` binary, so a hung fetch is skipped with the usual warning instead of failing sandbox setup. Explicit clones are unchanged.

`@opengeni/github` adds `findInaccessibleGitHubAppInstallationRepositories`. `@opengeni/runtime` exports `OPTIONAL_REPOSITORY_CLONE_TIMEOUT_SECONDS`, and `repositoryCloneCommand` and `runRepositoryCloneHook` accept an optional per-repository timeout.

`@opengeni/react` keeps the `optional-repository-access` report out of the transcript, like the routine repository-clone event.
