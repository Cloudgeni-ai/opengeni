---
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

A chat's own compute box is now called its workspace machine in its fault copy and turn-setup note, matching the rest of the app. Its machine-protocol faults start with "[workspace machine]" instead of "[cloud computer]" (for example "[workspace machine] this chat's workspace machine stopped answering; it is most likely restarting"), and the turn-setup clock and DNS note starts with "[Opengeni checked this chat's workspace machine before this turn]". `isConnectedMachineOutcomeUnknownOutput` recognizes the new prefix and still recognizes "[cloud computer]" receipts stored in earlier chats. Connected Machine wording is unchanged.
