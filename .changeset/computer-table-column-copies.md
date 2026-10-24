---
"@opengeni/runtime": patch
"@opengeni/browserd": patch
---

A macOS table no longer reads as three tables. macOS lists every cell again under each AXColumn, as new elements with the same role, label and bounds. A computer reading now lists such an element once, and a step that names it by role and name finds one element instead of an ambiguous pair. This holds in browserd's own lookup and in CUA's (fork pin 7451bb5d3). Same-named elements at different places still count as separate elements.
