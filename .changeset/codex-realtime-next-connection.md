---
"@opengeni/api-router": patch
---

Subscription voice no longer fails when one connected Codex account has lost voice. A connection's recorded plan can still say it has voice after the plan was cancelled, and the provider then refuses the call (404, or 403 without the entitlement). The call now moves on to the next connected subscription, and the server logs each refused connection with the provider's status and reason. Every other failure still ends the call.
