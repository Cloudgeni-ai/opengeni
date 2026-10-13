---
"@opengeni/agent-proto": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": patch
---

Record why each attached Chrome profile connection ended. Every connection generation change ends that profile's live browser sessions, but the reason only existed in machine logs, so a Chrome-side port close could not be told apart from a crashed native host. The native host now sends a final closing frame naming why it is shutting down (Chrome closed the port, Chrome sent an unreadable message, writing to Chrome failed); an end without that frame means the native host itself vanished, and a hello or message the agent refuses is reported as rejected. The agent includes its recent connection ends in every inventory snapshot, and the server keeps a bounded per-profile history in `attached_browser_devices.connection_history` (rolling migration `0770`). Generations that ended without a report are still recorded: as `agent_restarted` when the whole bridge was replaced, otherwise `unreported` for agents too old to report.

The bridge is also harder to disconnect by accident. An oversized tab title is truncated and an oversized tab URL makes that tab uncontrollable, instead of either one tearing down the whole profile connection. Fields a newer extension adds are ignored rather than rejected. Native-host diagnostics now go to stderr, never to the stdout channel Chrome reads frames from.
