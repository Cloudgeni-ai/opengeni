---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Make the named shared-workspace Member role a full teammate. Members can now take over a session's desktop and terminal, edit a session's files, connect their own accounts and model subscriptions, attach session MCP servers, create Sandbox Environments, see and pick Connected Machines, manage any Site they can see (Site Data, Site SQL, publication, takedown and restore), and author, install and review workspace Skills. Rolling migrations 0864-0866 update the preset, lift older named Member sets written by overlapping binaries, and backfill exact-match memberships in batches; custom and external memberships are unchanged. Settings-class powers (workspace settings, members, API keys, the GitHub App, integration and plugin install, machine enrollment, workspace provider keys, the Slack bot and the default Sandbox Environment) stay Admin-only. Personal-workspace owners also gain `rigs:manage`.
