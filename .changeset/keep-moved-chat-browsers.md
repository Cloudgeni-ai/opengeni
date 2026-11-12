---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Listing browsers and Desktops no longer ends the ones on a Connected Machine their chat has moved away from. A browser left there keeps running with its profile, as the refusal to use it from the new machine already says, so moving the chat back continues in the same browser with its sign-ins. Before, any listing (the app polls them) retired it within seconds of a move, even a brief one, and its signed-in state could not be resumed. Ending it still retires it on that machine.
