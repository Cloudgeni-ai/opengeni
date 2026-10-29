---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

A saved message that was sent for one of the person's machines no longer leaves the chat at a dead end after the chat moves to another of their machines. The chat now names the machine the message was sent for, offers "Run it on …" (move back, then one recheck), and explains how to send it again on the current machine instead of offering a recheck that can't pass. `SessionMachineAccess` gains `queuedTurnNotApprovedHere` and `queuedTurnApprovedMachines` (machine names only for the message's sender), and `@opengeni/react/session` exports the shared model. The generic "not approved for this chat" wording no longer tells the owner to ask the owner.
