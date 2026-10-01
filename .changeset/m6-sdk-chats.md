---
"@opengeni/sdk": minor
---

Add `chats: "private" | "shared" | "isolated"` to the session proxy and chat facade,
and `agent` to the facade. With an authenticated `user`, the facade now defaults
to private chats with personal Knowledge on, instead of session-only agent reach
with Knowledge authoring off. Without a user, omitting `chats` keeps the legacy
workspace visibility, session-only reach and Knowledge authoring off. Explicit
private chats require a user.

The implicit renderer defaults to markdown when admitted by the server. On an
older or rollout-disabled server's `422 agent_config_not_enabled`, the facade
retries once without only that implicit agent and caches the refusal per instance.
Explicit agent settings are never stripped; their 422 gives actionable setup guidance.

Private uses private visibility, session-only agent reach and user Knowledge;
shared uses workspace visibility, reach and Knowledge. Isolated additionally
provisions a separate workspace and external member for each tenant/user.
Explicit create fields override the defaults without changing server privacy rules.
The server-only `tenant-workspaces` subpath exposes `createWorkspaceIdResolver`;
the facade exposes `workspaceIdFor({ tenant, user }, { isolation: "user" })`.
Missing private-session enablement raises `OpenGeniSetupError` with owner/admin
API, SDK and web-app remediation.