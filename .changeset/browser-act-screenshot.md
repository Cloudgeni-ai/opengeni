---
"@opengeni/runtime": minor
---

browser_act accepts `includeScreenshot: true` and then returns a still image of the tab after the action in the same call, so screenshot-driven flows no longer need a separate browser_screenshot call after every action. A failed capture keeps the action's receipt and says why the image is missing.
