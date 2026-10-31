---
"@opengeni/worker-bundle": patch
"@opengeni/core": patch
---

A session with repositories from more than one GitHub App installation, or with an installation next to your own GitHub, now starts. The built-in GitHub App credential broker echoes the repository binding it minted for, which mixed sessions require.

Your GitHub's pull request, review and merge tools now get your credential. They were refused as "Personal GitHub credential is unavailable" because the frozen-connection check only knew connectors listed as MCP servers.
