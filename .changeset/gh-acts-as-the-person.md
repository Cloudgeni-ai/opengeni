---
"@opengeni/api-router": minor
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/runtime": minor
"@opengeni/worker-bundle": patch
---

`gh` in a managed sandbox acts as the person on repositories mounted through Your GitHub, as on their own computer: `gh repo`, `gh pr`, `gh run`, `gh workflow`, `gh issue`, `gh release` and `gh api` all work. A new personal GitHub gateway on the API (`/v1/github/personal/gateway/{api,uploads,git}/...`) adds the person's token per request after checking the session's short-lived broker pass, the connection, the repository allowlist and repositories removed from the chat; the token never enters the sandbox. The sandbox `gh` wrapper runs `gh` against the gateway through a per-command local proxy, and `gh repo clone` clones through it. Each request maps to the existing GitHub action policy, so one Allow/Ask/Block setting covers the `github_personal__*` tools and `gh`: reads pass, ordinary writes follow the policy, and destructive or unrecognised requests always ask. A request waiting for approval fails with a clear message and the normal approval card, and the exact same request runs once when sent again after approval. Git pushes as the person that delete a ref or force-push now ask. Sessions without a repository mounted as the person, Opengeni app repositories and Connected Machines are unchanged. The agent prompt tells the agent that `gh` acts as the person there.
