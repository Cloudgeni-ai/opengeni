---
"@opengeni/react": patch
---

Fix a dark composer on light pages: stock theme tokens rewritten by the host's CSS minifier (for example Next.js turning `#333333` into `#333`) are no longer mistaken for host customizations.
