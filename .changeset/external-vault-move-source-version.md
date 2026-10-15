---
"@opengeni/core": patch
---

A move out of a connected vault records the provider's version of the original from a fresh listing before copying its values. If it differs from the version Opengeni last synced (so the item's fields here may be out of date), the move is refused with `provider_conflict` before anything is saved; sync the vault and move again. The original is listed again just before archiving: if it changed, is no longer listed or cannot be checked, it is kept and the move reports the copy as saved with `sourceArchived: false` (`sourceChanged: true` when it changed). These checks are not an atomic read, and providers have no conditional archive, so an edit landing after the last check is still archived recoverably; providers that do not version items get no drift check.
