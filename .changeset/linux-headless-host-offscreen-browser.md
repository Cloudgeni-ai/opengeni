---
"@opengeni/browserd": patch
---

Open headed managed browsers offscreen on Linux hosts without a graphical display. A server or an agent running outside the desktop session has no display, so windowed Chrome exited before DevTools started and every default browser_open failed until the agent retried with headless=true. These hosts now run the same real browser and profile offscreen with an ordinary desktop User-Agent and screen, as on macOS.
