---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Your GitHub can use **All my repositories**, read only or read and write, instead of a chosen list: any repository the person can currently reach on GitHub works in chats, the git broker and the `github_personal__*` tools, checked live with GitHub (cached for a minute). The chosen list is kept, so switching back restores it. Repository search in the chooser and the session picker now asks GitHub, so it finds repositories beyond the first 100 (`query` on the personal repositories list; `allRepositoriesAccess` on the selection state and the replace request). New read tools work without a sandbox: `organizations_list`, `owner_repositories_list`, `workflow_runs_list`, `workflow_run_get` and `workflow_job_logs_get` (bounded, tail first, paged). One shared check, `checkPersonalGitHubRepositoryAccess` in `@opengeni/core`, decides repository access for every caller. GitHub REST bridge bodies and commit messages (issues, pull requests, comments, reviews, merges) keep their line breaks and tabs instead of being rejected as invalid.
