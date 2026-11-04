---
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

A command that fails because the chat's own cloud computer stopped answering no longer says "[connected machine] the machine is unreachable … the enrolled machine did not respond; it appears offline". It now reads "[cloud computer] the cloud computer this chat runs on stopped answering; it is most likely restarting". A command that never reached the box says nothing ran and to retry; one that was in flight says to check whether it took effect, fully or partly, before re-running it. A box that does not come back after a wake says so, that nothing ran, and to tell the person if a retry fails. Other machine-protocol faults from a cloud computer carry the "[cloud computer]" prefix. Connected Machines keep their existing wording. `isConnectedMachineOutcomeUnknownOutput` also recognizes the cloud computer receipt, so the timeline shows "outcome unknown" for it.
