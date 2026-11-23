---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

Record why a browser live view stopped getting frames. The browser controller now reports the state of its frame streams and live-view sockets (states, counts and times, never page content), and the API logs `browser.frame_stream.stalled` with that report when an open view's heartbeat finds a stream or view without a frame for ten seconds, so the reason survives the controller's sandbox stopping.
