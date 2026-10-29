---
"@opengeni/runtime": patch
---

Repository skills on a Connected Machine are found. The machine reports each listed entry by its bare name, and Connected Machine `listDir` passed that through as the entry's path, so skill discovery looked for `release/SKILL.md` at the workspace root instead of under `.agents/skills`, and found nothing. `listDir` now returns absolute paths for an absolute listing and workspace-relative paths for a relative one, as the other sandbox providers do.
