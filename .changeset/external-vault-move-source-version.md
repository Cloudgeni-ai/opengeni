---
"@opengeni/core": patch
---

A move out of a connected vault records the provider's version of the original from a fresh listing before copying its values, and lists it again just before archiving. If the original changed, is no longer listed or cannot be checked, it is kept and the move reports the copy as saved with `sourceArchived: false` (`sourceChanged: true` when it changed). Providers have no conditional archive, so an edit landing between that last check and the archive is still archived recoverably; providers that do not version items get no drift check.
