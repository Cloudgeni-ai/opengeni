---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
---

In a person's own connected Chrome, Chrome can leave a viewport capture of a tab behind another one in its window unanswered while it answers the next capture request at once. Such a capture is now asked again every second while none has answered, and the first answer is used, so these captures complete in about a second instead of stalling; one still unanswered after 5 s stops with a plain reason that suggests trying again. A capture of any other tab has the whole capture deadline instead of being cut short at 3 s. The extension transport now honours command time limits, so no connected Chrome capture waits past the capture deadline. When Chromium refuses a capture of a tab it has not drawn yet ("Unable to capture screenshot"), because it is not shown or is still loading (for example a tab restored at launch), the capture is asked again with pauses growing to 200 ms until the capture's bound, and a capture still refused then fails with a plain reason naming browser_tabs and browser_observe. The screenshot API now passes that reason, and the stall reason, to the caller instead of a generic error.
