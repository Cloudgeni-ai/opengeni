---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

An event added to a chat while Opengeni is archiving it, after the archive has read the chat's events, again appears in the stored transcript. Since the transcript started being written from the events the archive bundle reads, such an event was left out of both the bundle and the transcript. One more read after the bundle picks up these late events; normally it finds none.

Purging an archived chat's content now treats an invalid starting table (not a whole number, negative, or past the last table) as the first table. Such a value could previously skip every table and record the purge as complete with content still left. Valid starting tables behave as before.
