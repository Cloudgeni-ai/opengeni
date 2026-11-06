---
"@opengeni/artifact-tool": patch
---

PPTX import now checks a table's declared row and grid-column counts against the presentation table caps (10,000 rows, 1,024 columns) before building its rows x columns occupancy grid, and rejects grids with more slots than the XML node budget allows, since each slot needs its own cell element. Oversized tables fail with a `limit-exceeded` security error instead of allocating memory first and failing later.
