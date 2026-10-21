---
"@opengeni/connect": patch
---

Connecting an account no longer gives up after two minutes while the sign-in is still in progress. The Connect dialog stopped waiting after a fixed two minutes and showed "Connect polling timed out", even though the sign-in itself stays valid for much longer and can easily take more than two minutes, for example in the system browser a desktop app opens. Waiting now lasts as long as the sign-in attempt does, the backend still decides when it has expired, and if a wait does run out the person sees a plain message that they can try connecting again.
