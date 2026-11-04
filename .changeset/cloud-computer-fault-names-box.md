---
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

A command that fails because the chat's own cloud computer stopped answering no longer says "[connected machine] the machine is unreachable … the enrolled machine did not respond; it appears offline". It now reads "[cloud computer] this chat's cloud computer restarted or is restarting" and tells the model to retry once the box is back, which is usually within seconds. Other machine-protocol faults from a cloud computer carry the "[cloud computer]" prefix. Connected Machines keep their existing wording. `isConnectedMachineOutcomeUnknownOutput` also recognizes the cloud computer receipt, so the timeline shows "outcome unknown" for it.
