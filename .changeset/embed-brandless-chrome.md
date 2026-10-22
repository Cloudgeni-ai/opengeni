---
"@opengeni/react": patch
---

An embedded session app (the `embed` preset) no longer shows Opengeni branding a product did not ask for. The mobile header respects the `brand` switch. A new `starters` switch, off in `embed`, hides Opengeni's suggested first tasks (connect Slack, GitHub, Linear and so on). Someone without GitHub access in the workspace no longer gets a "GitHub status unavailable" toast every time the window regains focus.
