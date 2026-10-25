---
"@opengeni/ogtool": patch
---

`ogtool call` reads its arguments from a file with `@path` or from stdin with `-`, the same forms the native `codemode call` accepts, so large arguments no longer have to fit in one command-line argument.
