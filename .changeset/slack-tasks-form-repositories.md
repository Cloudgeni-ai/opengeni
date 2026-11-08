---
"@opengeni/api-router": patch
"@opengeni/core": minor
"@opengeni/db": minor
---

A new Slack task now starts with the repositories in the person's new-chat form, the same ones a new chat in the app would start with, instead of up to five repositories gathered from every session the person used in the last 30 days. It keeps the existing limits: at most five, in form order, only through the workspace GitHub App catalog on each repository's default branch, archived and empty repositories skipped, and every one best effort. A form with no repositories starts the task with none. Connectors, Opengeni tools, Sandbox Environment and compute still follow the workspace defaults, and an explicitly chosen model still carries over.

`@opengeni/core` adds `getActorNewSessionStartChoices`, which reads the form once and returns the explicitly chosen model policy and the form's repositories. `getActorNewSessionModelChoice` is unchanged.

Breaking: `@opengeni/db` removes `listRecentSessionRepositoryResources`, which only served the old Slack selection.
