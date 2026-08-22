---
"@opengeni/api-router": patch
---

The first-party `github_repositories_list` MCP tool now attaches `githubInstallationId`/`githubRepositoryId` to every allowlisted repository resource, public or private, so sessions and scheduled tasks built from it receive a scoped installation token instead of an anonymous read-only clone.
