---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Add `includePinned: false` to session-page reads so callers loading the pinned section separately can skip repeated pin hydration. The default response and ordinary-page pin exclusion are unchanged.

Bound the browser event working set to 16 MiB or 20,000 events, with durable history accessible through existing navigation. Avoid copying the event window when no additional question evidence is needed.
