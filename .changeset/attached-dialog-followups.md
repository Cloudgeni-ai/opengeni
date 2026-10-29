---
"@opengeni/browserd": patch
---

In the person's own Chrome, cancelling a dialog only the person can see now takes about 2 seconds instead of about 4: the checks for whether the tab's page answers wait 1 second each instead of 2. Using a tab whose page did not answer once gets the full 10 second attach time again, so a slow page is not reported as not answering forever. The messages for a dismiss that found no dialog now say only what was observed: a tab no longer in front was not hidden, a tab that was hidden for a moment is most likely busy, and a tab that cannot be hidden from here may or may not hold a dialog.
