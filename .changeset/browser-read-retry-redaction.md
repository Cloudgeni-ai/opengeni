---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
---

Browser reads hold up better and say what went wrong. Reading a page whose frames are still loading, which is common just after a browser reopens, no longer fails at once: the driver pauses briefly between its attempts, and a tab list, observation, page read or screenshot that still fails for an unclassified reason is tried once more and then reported as a retryable "unavailable" error instead of a final server error, with the driver's message logged. Actions are never repeated. Reading a page or container that holds a password, payment or private field now returns its public text with only those fields withheld, instead of withholding the whole container. A connected machine that does not answer an action in time now says that the action timed out and its outcome is unknown, instead of mentioning the live view.
