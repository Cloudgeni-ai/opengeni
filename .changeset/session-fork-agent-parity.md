---
"@opengeni/db": patch
---

A forked chat is now the same agent as the one it was forked from. Forks keep the source's connector and built-in tool selection and tool policy, agent configuration, model and execution settings, instructions, provider account authority, code search, Memory and agent access settings and session MCP servers, instead of starting with no tools and default settings. Only the fork's identity, owner, audience, history and runtime state are its own; when someone else forks a chat, it binds to them and leaves out the MCP server credentials the original creator supplied.
