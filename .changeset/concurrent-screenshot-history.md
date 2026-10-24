---
"@opengeni/db": patch
---

A turn whose history holds retained screenshots starts faster: the session's screenshot rows load in one query and the images are read from storage concurrently, each once, so one slow read no longer holds up every image after it. `getSessionRetainedScreenshotArtifacts` returns a session's own retained screenshots for a set of ids.
