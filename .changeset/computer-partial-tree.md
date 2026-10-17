---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

A desktop observation now says when the accessibility tree is partial. When CUA stops reading a window early (a slow or very large app runs out its time budget, or the element limit is reached), the semantic snapshot carries `incomplete` with the reason and how many found elements were not read, and the model's text view ends with a line saying the tree is partial and to use the screenshot for anything not listed. Before, a partial tree looked complete, so a model could conclude a visible control did not exist.
