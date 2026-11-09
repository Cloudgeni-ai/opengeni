---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A message that couldn't start because of access now starts by itself once that is fixed. When its machine is allowed for the chat, the sender's workspace access is restored, or the chat moves to a machine it may use, the saved message is released and started exactly once. A paused, cancelled or edited chat is left alone, and a claim that raced the change is re-read instead of parked. The "Recheck access" button is gone. The notice says what is blocking the message and offers the one action that fixes it: the machine's owner gets "Allow for this chat", others learn who can allow it, and lost membership names a workspace admin. Only an unknown failure offers "Try again". A claim refused because a personal machine isn't approved now reads as "Machine access needed", not as a generic permission check. `useSessionStart` adds `allowMachine`, `needsMachineAccess` and `refresh`, and `@opengeni/react` exports `allowMachineForChat`, `sessionAdmissionNeedsMachineAccess` and `sessionAdmissionMachineAccessCopy`.
