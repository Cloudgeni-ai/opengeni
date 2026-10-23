---
"@opengeni/core": patch
"@opengeni/db": patch
---

Read public workspace model metadata in one short tenant scope instead of three.
Keep default selection, fresh admission, subscription discovery and execution
credential resolution separate; no catalog or authorization cache is introduced.
