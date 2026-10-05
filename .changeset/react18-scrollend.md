---
"@opengeni/react": patch
---

The conversation timeline now listens for `scrollend` natively. React 18 has no `onScrollEnd` prop, so React 18 hosts logged "Unknown event handler property `onScrollEnd`" and never ran the handler that decides when a reader has scrolled away from the live tip.
