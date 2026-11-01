---
"@opengeni/react": patch
---

In the macOS app, the window bar names the open Capabilities page (for example "Slack" or "New Slack agent") instead of always saying "Capabilities". The catalog stays mounted under an open page and its header kept the bar; `WindowBarTitleBoundary` takes a `when` prop so a hidden page lets go of the bar.
