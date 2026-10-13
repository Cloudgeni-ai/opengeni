---
"@opengeni/tool-gateway": patch
---

Accept the exact strings `true` and `false` where the tool schema needs a boolean, including inside `anyOf`/`oneOf` input alternatives. Any other string (`"1"`, `"True"`, `" true"`, `""`) is still rejected, and the repaired call must still pass the original schema.
