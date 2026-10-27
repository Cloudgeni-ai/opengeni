---
"@opengeni/browserd": patch
---

Screenshots of a managed browser tab that is not in front no longer stall for 10 seconds and time out. Every managed Chromium launch, headless or headed on any platform, now copies a freshly repainted surface for captures instead of waiting for a redraw that Chrome never shows for a tab another tab covers. Captures stay target-scoped: no tab is brought to front and the window's active tab does not change. In a person's own connected Chrome, which cannot take that launch switch, a viewport capture of a covered tab that Chrome does not draw now stops after 3 seconds with a plain reason naming browser_tabs and browser_observe, instead of waiting out the whole capture deadline.
