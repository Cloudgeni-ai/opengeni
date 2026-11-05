---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A meeting is now heard in pieces while it is still being recorded, when its speakers come from our diarizer or the model doesn't tell them apart itself. The worker following a meeting decodes each track as it arrives, cuts it at the speakers' pauses (about one to two and a half minutes a piece, long quiet stretches never sent) and has each piece transcribed at once with the model and options the API would choose at the end. After the meeting stops, the final transcript reuses every piece whose audio and question are unchanged and sends only the rest, so an hour-long meeting has only its last minutes left to hear. A track is decoded again only once a new piece could be cut.
