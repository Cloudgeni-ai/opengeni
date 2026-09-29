---
"@opengeni/react": patch
---

Load the optional workspace Files renderer asynchronously when first mounted, keeping chat and workspace
state mounted while its renderer loads. Preserve file capability checks and the
existing visited-tab lifetime.