---
"@opengeni/react": patch
---

Changing a polled read's interval no longer aborts and repeats the read in flight. The session list switches from polling to live list hints shortly after it opens; that switch used to cancel its first `GET /sessions` and send a second one. Now the first read finishes and only the poll schedule changes.
