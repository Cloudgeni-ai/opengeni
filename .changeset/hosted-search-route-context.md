---
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Allow operators to configure a registry model's hosted-search context size. Omitted settings preserve the existing SDK default and execution identity. Explicit changes are bound to the model definition so accepted turns cannot silently switch search settings.
