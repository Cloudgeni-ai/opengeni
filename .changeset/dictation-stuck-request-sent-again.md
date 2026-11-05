---
"@opengeni/core": patch
---

A dictation request that a speech-to-text provider sits on is no longer waited out. If the provider hasn't answered after five seconds plus a quarter of the audio's length (20 s for a minute), the same audio is sent once more and whichever answer comes first is used and charged once; the other request is cancelled. Before, one stuck request at the ChatGPT dictation endpoint kept a 54-second dictation loading for over four minutes, up to the ten-minute provider deadline. A request that fails outright is still not sent again.
