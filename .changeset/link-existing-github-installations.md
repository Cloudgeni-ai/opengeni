---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/github": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/worker-bundle": patch
---

Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

- Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
- Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
- Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
- Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.
