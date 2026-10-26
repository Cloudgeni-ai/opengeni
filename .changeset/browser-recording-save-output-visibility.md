---
"@opengeni/api-router": patch
---

Stopping a browser recording no longer fails when object storage shows the freshly made video or action log a few seconds late, as storage that replicates in the background can. The save reads both back with the usual short visibility retry, keeps answering 202 so the client asks again for up to a minute after the video was made, and only then fails with a 503 `upstream_unavailable` whose message says the video was made but could not be read back and nothing was saved, with `details.code` `browser_recording_output_unreadable`. Before, a single missed read answered a 503 with the generic "temporarily unavailable" text and ended the save.
