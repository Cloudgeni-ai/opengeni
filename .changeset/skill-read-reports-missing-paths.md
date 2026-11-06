---
"@opengeni/runtime": patch
---

`skill_read` with explicit paths no longer fails the whole call when one path is not a file of the Skill. It returns the files that exist, names each missing path in `missing`, and lists the Skill's own paths in `availablePaths` (at most 50 entries and 4 KB, with `availablePathsOmitted` and a pointer to `listFiles:true` when bounded), plus a short `note` saying a missing path will not appear on retry and that a file another Skill names is read from that Skill. A read where no requested path exists returns the same fields with empty `files` as a normal result instead of the generic "Please try again" tool error. Complete reads, the default `SKILL.md` read and the tool description are unchanged.
