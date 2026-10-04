---
"@opengeni/core": patch
---

Add an unused private native declaration request/data join that owns verified bytes and rechecks current expiry and configuration after the live-origin SQL lock wait. It issues no grant, native context or provider permission.