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

Add workspace-scoped GitHub App installation bindings with independent repository allowlists.

- Configure the OAuth callback in generated App manifests, but fail closed for all new workspace-installation binding: GitHub setup callback parameters are spoofable, while user installation visibility and repository administrator permission do not prove install/configure authority.
- Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
- Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
- Add SDK and web controls to inspect and unlink an existing workspace binding without uninstalling the GitHub App or affecting another workspace.
