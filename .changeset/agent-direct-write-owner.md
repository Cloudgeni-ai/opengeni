---
"@opengeni/core": patch
---

An agent in a private chat can again save files to that chat's cloud workspace through the API, for example when stopping a browser recording. The write is now attributed to the person who started the chat instead of the internal worker identity, which the private-chat owner check rejected.
