---
"@opengeni/runtime": patch
---

End model execution after a successful trusted `wait_for_input` call, including
calls routed through native shell and Codemode. Preserve settled tool receipts
and normal worker completion without requiring a final assistant message.