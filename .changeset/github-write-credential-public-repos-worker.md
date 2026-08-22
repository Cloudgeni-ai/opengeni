---
"@opengeni/worker-bundle": patch
---

Give sandboxes a scoped GitHub App installation token for every bound repository, public or private. Before credential minting and the runtime clone plan, the turn worker resolves bare `github.com` repository resources (API callers, older sessions, agent-spawned children inheriting a parent's resources) against the workspace's auditable installation allowlists and stamps the ids for that turn when exactly one allowlist matches; a bound-but-unusable repository stays an anonymous clone and posts a visible `credential.auth_needed` warning. Connected Machines are unaffected and resolution never fails the turn.
