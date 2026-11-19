---
"@opengeni/browserd": patch
---

A computer-use window read that asks only for what changed since an earlier read (`since`), with structured elements (`tree_format` "elements" or "both"), no longer fails with "internal typed output mismatch … returned_element_count does not match elements". The pinned CUA driver trimmed the elements to the changed rows but kept the full read's count, so the typed output check rejected the response and the agent got an unknown outcome on a plain read. The count now follows the rows returned.
