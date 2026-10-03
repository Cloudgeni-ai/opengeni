---
"@opengeni/contracts": patch
---

Preserve an omitted Insights sources facet when parsing interim usage responses. An explicit sources array advertises implemented source/custom support; validation must not manufacture that capability for an older raw backend.