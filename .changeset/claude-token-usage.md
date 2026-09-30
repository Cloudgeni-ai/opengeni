---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/config": patch
"@opengeni/db": minor
"@opengeni/runtime": patch
---

Claude subscription setup and replacement require only the setup token. Observe
provider usage and reset windows from ordinary model responses, including quota
errors, and expose scoped cached reads and authorized refreshes. Preserve the last
reading when inference-only tokens cannot use the separate usage endpoint; fence
cached readings against credential replacement and revocation.
