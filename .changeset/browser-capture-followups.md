---
"@opengeni/browserd": patch
---

In a person's own connected Chrome, the 3 second limit on viewport captures now applies only to a tab Chrome reports as not in front of its window; a capture of any other tab has the whole capture deadline instead of being cut short at 3 s. The extension transport now honours command time limits, so no connected Chrome capture waits past the capture deadline. When Chromium refuses a capture of a tab it has not drawn yet ("Unable to capture screenshot"), the capture is asked again shortly after, and a capture that keeps being refused fails with a plain reason naming browser_tabs and browser_observe.
