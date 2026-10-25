---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

A message someone else sends to a chat that runs on another member's personal machine no longer blocks the chat. It waits for the machine's owner instead: it never starts or interrupts the owner's turns, the owner's next message brings it to the agent as context, and it runs on its own once the chat moves to a machine the sender may use. Steering a waiting message, and an agent steering such a chat on behalf of somebody else, are refused with a clear reason. Send results report `waitsForMachineOwner`, and the chat's machine explanation lists whose messages wait (`waitingMessages`). This takes effect once a later release grants the runtime the new machine-owner lookup; until then chats behave as before.
