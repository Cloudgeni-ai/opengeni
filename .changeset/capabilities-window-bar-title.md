---
"@opengeni/react": minor
---

In the macOS app, the window bar names the open Capabilities page (for example "Slack" or "New Slack agent") instead of always saying "Capabilities". The catalog stays mounted under an open page and its header kept the bar. `WindowBarTitleBoundary` takes a `fallback` prop: headers inside it take the bar only while no other header has a title.
