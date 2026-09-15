---
"@opengeni/contracts": minor
"@opengeni/db": patch
---

Expose named Plugin removal impact using the same classifier as Skill source
release. Preserve customized/re-scoped Skills, resolve remaining owner names
within workspace scope, and add optional preview-token fencing with refreshed
409 previews when ownership or Skill state changes before confirmation. Retain
Connection ownership, immutable Skill history, and human-only removal authority.

Freeze the pre-comparison locked Skill head set through cleanup. A head made
visible by another subject during confirmation now aborts removal with a refreshed
409 preview instead of silently expanding the deactivation set.