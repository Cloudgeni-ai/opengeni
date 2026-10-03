---
"@opengeni/runtime": patch
---

Allow automation and session startup with an empty first-party permission ceiling without minting a delegated token or connecting to OpenGeni MCP. Preserve host-owned adapters, independent connection credentials, and existing nonempty permission behavior; requested first-party capabilities without authority remain unavailable.