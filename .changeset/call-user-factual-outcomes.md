---
"@opengeni/api-router": patch
---

`call_user` no longer tells the agent never to call again. Its description and every result (answered, declined, missed, cancelled, and each refusal) now state only what happened, what the person sees (a missed call leaves a missed-call notice with the reason) and, for a refusal or decline, when this chat can call again. Whether to call again is left to the agent, which the description reminds that every call interrupts the person, so it weighs how urgent it is and whether they asked to be called. The call limits are unchanged.
