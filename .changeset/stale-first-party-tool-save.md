---
"@opengeni/core": patch
---

Saving a session's connector selection no longer fails with `422 first-party MCP tool is disabled by deployment policy` when the session's stored tool catalog still names a first-party tool the deployment has since disallowed. The update now drops those tools, matching what the runtime already does, instead of blocking unrelated connector toggles.
