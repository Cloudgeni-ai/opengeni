---
"@opengeni/db": patch
---

Match scheduled-run admission to the target session's tool-inheritance semantics.
An omitted turn override inherits session tools instead of being mistaken for an
explicit empty override. Explicit overrides and policy-drift rejection remain
unchanged.