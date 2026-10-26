---
"@opengeni/react": patch
---

One Up press is now enough to pull a message you just queued back into the composer. The queue row shows a sent message as queued at once, but Up used to do nothing until the server's queue caught up a second or so later, so the first press was lost. Up pressed in that window now waits for the message to land and then recalls it. It still never pulls back an older message instead: if the agent takes the new one first, the composer stays as it was and shows "Already sent", and typing while it waits keeps what you typed.
