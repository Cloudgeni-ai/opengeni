---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

A browser page read (an observation, a tab's state, a DOM read) now ends within the time the API waits for it. On a page that keeps its main thread busy for seconds at a time, such as one rendering WebGL in software, each of a read's page commands answered within its own timeout, but together they ran past the API's 60 seconds. The API then reported the workspace as temporarily unavailable and tried the read once more, so the caller waited two minutes for a misleading error. The read now stops 10 seconds before the API gives up and reports `tab_not_responding`, the same as for a tab that stops answering entirely. Reads made as part of an action keep the action's own budget.
