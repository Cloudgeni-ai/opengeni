---
"@opengeni/runtime": patch
"@opengeni/codemode": patch
"@opengeni/ogtool": patch
"@opengeni/contracts": patch
"@opengeni/tool-gateway": patch
"@opengeni/worker-bundle": patch
---

Connector tools have readable names: `<connector>_<account tag>__<tool>` (a configured server's readable id instead of the connector), decided by the tool's identity alone, instead of a name with a different hash per tool. Every tool of one server shares a guessable prefix, and a name never comes to mean another account's or connector's tool. Codemode paths use the same namespace. `tool_search` names, `ogtool show` and Codemode accept a tool's published `server.tool` or its own name, while a call needs a name carrying its server; a query naming several tools loads all of them whatever its limit, and a miss suggests the closest tools. `ogtool show` and the native client's `codemode show` accept several names. A Skill can list the tools it uses in a `tools:` frontmatter key, and reading it loads them. A call to a tool's former name runs nothing and returns its current name; approvals stay keyed by the tool's identity.
