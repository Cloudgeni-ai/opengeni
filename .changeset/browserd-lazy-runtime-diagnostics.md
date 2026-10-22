---
"@opengeni/browserd": patch
---

Managed and attached browser tabs no longer keep the CDP Runtime domain enabled. Pages can detect an enabled Runtime domain (the most common automation tell), so console messages and uncaught page errors are now read on demand when diagnostics are requested: browserd briefly enables Runtime, takes the messages Chrome buffered for the current document, and disables it again. Observations count console and page errors that a diagnostics read has reported.
