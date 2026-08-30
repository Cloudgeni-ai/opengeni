# `@opengeni/tool-runtime`

Caller-neutral mechanics for OpenGeni's canonical tool catalog.

The package validates canonical tool identities and JSON Schemas, allocates
stable model names and programmatic paths, generates TypeScript declarations,
normalizes structured MCP results, and invokes tools through bounded
argument/result and timeout controls. It does not decide who may call a tool,
which credentials to use, or which surface may expose it; those authorization
decisions remain with the API, worker, Code Mode, or Apps host composing the
catalog.

Consumers should treat `identity.serverId` plus `identity.toolName` as the
authority-bearing selector. Display titles, model names, and generated dotted
paths are projections only and must never be parsed back into authority.
