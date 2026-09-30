---
"@opengeni/sdk": minor
---

Add `chats: "private" | "shared" | "isolated"` to the session proxy and chat facade,
and `agent` to the facade. The facade now defaults to private chats with personal
Knowledge on, instead of session-only agent reach with Knowledge authoring off.
Its renderer now defaults to markdown. Private chats need an authenticated
`user`; service-owned chats should explicitly choose `chats: "shared"`.
The facade now sends an agent configuration, so deployment operators must enable
`OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED=true` before using it.

Private uses private visibility, session-only agent reach and user Knowledge;
shared uses workspace visibility, reach and Knowledge. Isolated additionally
provisions a separate workspace and external member for each tenant/user.
Explicit create fields override the defaults without changing server privacy rules.
The server-only `tenant-workspaces` subpath exposes `createWorkspaceIdResolver`;
the facade exposes `workspaceIdFor({ tenant, user }, { isolation: "user" })`.
Missing private-session enablement raises `OpenGeniSetupError` with owner/admin
API, SDK and web-app remediation.