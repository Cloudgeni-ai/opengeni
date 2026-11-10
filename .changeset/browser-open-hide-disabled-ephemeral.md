---
"@opengeni/runtime": patch
---

`browser_open` no longer offers `storageMode: "ephemeral_context"` to agents on a deployment that has ephemeral browser contexts turned off. The server refused it there, so an agent that tried it lost a call. The option and its guidance now appear only when `OPENGENI_EXPERIMENTAL_BROWSER_CONTEXT_POOL_ENABLED` is on. Hosts that build the interaction tools themselves pass `ephemeralBrowserContexts: true` to offer it.
