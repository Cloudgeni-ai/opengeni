---
"@opengeni/browserd": patch
---

In a person's own connected Chrome, the 3 second limit on viewport captures now applies only to a tab Chrome reports as not in front of its window, and the controller enforces it itself, since the extension transport does not time commands out. A slow capture of the tab in front is no longer cut short. When Chromium refuses a capture of a tab it has not drawn yet ("Unable to capture screenshot"), the capture is asked again shortly after, and a capture that keeps being refused fails with a plain reason naming browser_tabs and browser_observe.
