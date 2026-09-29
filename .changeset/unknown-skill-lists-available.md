---
"@opengeni/worker-bundle": patch
---

`skill_read` and `skill_checkout` now answer an identifier that resolves to no Skill with the available Skills (id and name only, bounded to 25 entries and 4 KiB, entries resembling the requested identifier first, the rest via `skill_search`) instead of only "Skill is not available in this session", so the model can retry with a valid id.
