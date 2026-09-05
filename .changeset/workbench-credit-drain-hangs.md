---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Stop Files, Terminal, Browser, and Desktop hanging when the account is credit-drained: map sandbox viewer admission to HTTP 402/429, fail prepared Browser/Computer sessions instead of leaving them starting, and show the credit-exhaustion error instead of an infinite wake.
