---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
---

Keep large browser download exports running across bounded request windows and join the same transfer on retry. The SDK polls the same save operation until the file reaches its workspace destination; existing final-only HTTP callers remain compatible.
