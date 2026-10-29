---
"@opengeni/runtime": patch
---

Tool search finds the right tool in large catalogs on every model route. On OpenAI and Codex routes, a search that neither names a tool nor matches one clearly is now followed by a short note listing the close candidates it did not load, so the agent can load the right one instead of seeing only a guess or "no matching tools". Exact-name loads and queries now accept the names integrations publish (`projects.search`, `projects_search`) and dotted forms (`server.tool_name`), including for tools whose model names are digest aliases, and `tool_list` prefixes match the readable part of those names, listed alphabetically.
