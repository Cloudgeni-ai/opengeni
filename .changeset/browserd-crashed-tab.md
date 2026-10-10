---
"@opengeni/browserd": patch
---

A browser tab whose page process crashed no longer hangs every command until it times out with a retryable "upstream unavailable" error. The browser service now notices the crash, both when it happens and when it later attaches to an already-crashed tab. It fails page commands on that tab at once with a clear, non-retryable error that says to open a new tab. The rest of the browser keeps working.
