---
"@opengeni/worker-bundle": patch
---

An event added to a chat while Opengeni is archiving it, after the archive has read the chat's events, again appears in the stored transcript. Since the transcript started being written from the events the archive bundle reads, such an event was left out of both the bundle and the transcript. One more read after the bundle picks up these late events; normally it finds none.
