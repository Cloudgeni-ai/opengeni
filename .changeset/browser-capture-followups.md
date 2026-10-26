---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
---

In a person's own connected Chrome, the 3 second limit on viewport captures now applies only to a tab Chrome reports as not in front of its window; a capture of any other tab has the whole capture deadline instead of being cut short at 3 s. The extension transport now honours command time limits, so no connected Chrome capture waits past the capture deadline. When Chromium refuses a capture of a tab it has not drawn yet ("Unable to capture screenshot"), because it is not shown or is still loading (for example a tab restored at launch), the capture is asked again with pauses growing to 200 ms until the capture's bound, and a capture still refused then fails with a plain reason naming browser_tabs and browser_observe. The screenshot API now passes that reason, and the 3 s stall reason, to the caller instead of a generic unavailable or timeout message.
