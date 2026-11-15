---
"@opengeni/core": patch
---

Separate installs of one API integration definition (a second account added as its own install) are now labelled as accounts of one connector: they share the definition's name and each names its account, so the model can tell them apart and a tool search reaching one names the others.
