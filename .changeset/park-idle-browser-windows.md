---
"@opengeni/browserd": patch
---

Idle managed browsers on a Linux desktop no longer burn CPU. A windowed managed browser held focus emulation on every tab, which keeps a page rendering as if it were being captured, and Linux has no window occlusion tracking, so every animated page in every idle browser kept drawing frames through software GL: on one shared desktop, 33 mostly idle browsers used about 10 CPU cores.

After a minute without any use and with no live view open, the controller now parks the browser: it switches focus emulation off and minimizes the browser's windows, so its pages become hidden and stop drawing (timers, network activity and screenshots keep working). The next observe, action, tab operation, screenshot or live view presents the browser again before it runs, so agents and people always act on a normally rendering page. A browser linked to a ComputerSession keeps its window, and macOS, Windows and offscreen browsers are unchanged. In a measured case, an animated page dropped from about 3 CPU cores to 0.02 while parked.
