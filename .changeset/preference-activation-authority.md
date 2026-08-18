---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Preference descriptors now carry `activationAuthority` (`human_confirmed` | `automatic` | `null`) alongside `provenance.trust`. Trust stays the frozen creation-time fact - a revision an agent proposed reads `untrusted_proposal` forever, and both activation adapters still require that value - while the new field answers the separate question of whether a human explicitly confirmed the activation or policy activated it automatically, read from the governed-learning activation receipt at descriptor-build time. Descriptors built before this field existed parse as `null`, which keeps their immutable stored JSON and pinned descriptor hash valid.
