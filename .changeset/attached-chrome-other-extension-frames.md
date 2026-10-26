---
"@opengeni/browserd": patch
"@opengeni/browser-extension": patch
---

Attached Chrome keeps working in a tab while a password manager shows its inline menu. Chrome ends the extension's debugging of a tab as soon as another extension's frame starts loading in it, and while that frame loads it can refuse every command on a new attachment without running it. The extension now removes those frames and sends a refused command again once (still within the existing limit on how often it removes frames, and never onto a different attachment), and a frame that keeps coming back fails with the existing error that names the password manager and says what to do.

browserd now treats Chrome's "Debugger is not attached" answer as the end of that attachment instead of an unclassified error, so the next call attaches again. Observations, tab state, page reads and screenshots whose attachment ends part way are read once more on a new attachment. An action whose attachment ends after input was sent is `outcome_unknown` with a fresh observation of the tab on the new attachment, so the agent can see whether the input landed; an action that ended before any input stays a definite `failed`. Chrome's refusal of a single command because of another extension's frame is a definite failure that leaves the tab usable, rather than a retryable error that never cleared. The tab state route of browserd no longer answers a lost attachment with a 500.
