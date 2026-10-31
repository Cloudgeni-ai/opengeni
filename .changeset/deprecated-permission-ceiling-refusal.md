---
"@opengeni/core": patch
---

When a custom-policy organization key states or delegates a deprecated permission name (such as `variable-sets:use`) whose canonical permission its policy holds, the 403 now says so and names the permission to state instead (`secrets:use`), rather than the generic "outside the organization key policy". What is allowed is unchanged.
