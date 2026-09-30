---
"@opengeni/jev": patch
"@opengeni/runtime": patch
"@opengeni/contracts": patch
---

`code_search` never searches or returns platform credential material. `.opengeni/` (Codemode tokens, Git credential files and bindings), `.azure/` (the Azure CLI login cache) and `.config/opengeni/` (Connected Machine enrollment credentials) are excluded at any depth from every ripgrep call, and an explicit path into one of them, in any spelling or through a symlink, is ignored.
