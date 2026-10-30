---
"@opengeni/react": patch
"@opengeni/sdk": minor
"@opengeni/desktop": patch
---

In the macOS app, the sidebar toggle and a chat's header now sit on the same line as the traffic lights, also with desktop apps from before the new top bar (0.1.33 and older), whose traffic lights sit lower, and when the page is zoomed. At a large zoom, where they don't fit above and below that line, they start at the top of the window instead of being cut off. The desktop bridge adds `windowBarHeight` and `zoomFactor()`.
