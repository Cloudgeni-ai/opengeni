---
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

`modelContextTools` (a session's opening tools) can now name an application's own MCP tools by the names its server publishes, not only Opengeni's first-party tools. A host whose chat opens on one of its records, such as an estimate, can have the first turn load the tools for that record before its first model request, as a tool search by name would, so the agent can use them without searching first. The session's tools, tool policy and first request's tool block are unchanged, and a name loads only if a server the session selects authorizes a tool by that name.
