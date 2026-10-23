---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Once an agent uses the native `cua_*` computer tools in a session, `computer_act` and `computer_observe` stop reading elements themselves so the native element tokens stay valid. Their results used to say "The accessibility tree has no readable elements; use the screenshot", which sent agents to pixel clicks on windows full of controls. They now say the session reads elements with `cua_get_window_state` and to call it, and two such readings are no longer reported as "no element changed". Semantic snapshots carry this as `readByNativeTools: true`.
