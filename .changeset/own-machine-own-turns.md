---
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": patch
"@opengeni/contracts": patch
---

A person's own connected machine now runs that person's own turns in every workspace where they have it on, in private and shared chats alike, without asking again each chat. A machine is on in the owner's Personal workspace, in the workspace it was connected from (until the owner turns it off there), and in any workspace where the owner allowed it with standing permission. The first use where it is on by default records that standing permission, so the owner can turn it off later. Another person's turns still never run on someone else's personal machine; they keep waiting for the owner, unchanged.

Allowing your own machine from a chat's machine card, or moving a chat to it, now turns it on in that workspace from then on, and the card says so; in a shared chat it also notes that people in the workspace see what the agent does there. `disallowAgentsOnComputer` in the SDK now turns the computer off in a workspace even where it was on by default. The refusal reason and setup blocker for a personal machine say that its owner has not turned it on in this workspace.
