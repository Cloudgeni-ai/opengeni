---
"@opengeni/core": patch
---

Add GitHub App repository-binding resolution for bare `https://github.com/<owner>/<repo>` resources: parse coordinates, list the workspace's auditable installation allowlists under RLS, and stamp `githubInstallationId`/`githubRepositoryId` only when exactly one bound allowlist holds the repository id reported through an injected provider lookup. Unbound, non-allowlisted, ambiguous, and unavailable outcomes leave the resource bare and are reported so callers can warn without failing.
