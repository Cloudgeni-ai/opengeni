---
"@opengeni/runtime": minor
---

browser_open now includes a still image of the opened tab by default when it opens a URL (`initialUrl`), so the agent sees the page in the same call instead of following up with browser_screenshot. Set `includeScreenshot: false` to skip the image; opens without a URL keep the previous default of no image.
