---
"@opengeni/db": patch
---

Migration 0737 (Site audiences) lifts FORCE row security with plain `ALTER TABLE ... NO FORCE` statements on the four tables it reads and writes, and checks that every existing Site stays workspace-visible before it restores FORCE, so the check sees every row under the production migration owner.
