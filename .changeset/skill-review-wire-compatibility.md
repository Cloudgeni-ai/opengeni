---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Canonicalize typed Skill review cards using host-owned choices. Allow explicit
authorized Save/Don't save responses to existing exact-bound cards with the
legacy Other flag and null option descriptions, without rewriting cards,
manufacturing consent, or weakening human, tenant, turn, or revision fences.
Apply rolling migration 0458; pre-0435 runtimes remain unsupported.