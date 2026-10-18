---
"@opengeni/runtime": minor
---

browser_open accepts `includeScreenshot: true` and then returns a still image of the opened tab in the same call, so visual tasks no longer need a separate browser_screenshot call right after opening the browser. A failed capture keeps the opened browser's result and says why the image is missing.
