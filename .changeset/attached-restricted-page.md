---
"@opengeni/browserd": patch
---

Connected Chrome now refuses pages it cannot control (such as `chrome://` pages, other extensions and the Chrome Web Store) with a typed error that says so, instead of failing later with a generic CDP error, and a refused navigation no longer leaves a stray tab behind.
