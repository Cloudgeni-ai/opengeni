---
"@opengeni/runtime": patch
---

Detach provider response item identities from portable checkpoint requests while preserving inline history and tool call/result correlation. This prevents Azure from rejecting a message whose opaque reasoning identity was omitted during compaction. Classify the known rejection without persisting provider message content.

Explicitly disable tool selection for Azure-profile Responses checkpoints so historical tool records cannot yield a new tool call instead of summary text. Empty/provider failure safeguards remain unchanged.
