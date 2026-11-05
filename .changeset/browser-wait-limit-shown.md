---
"@opengeni/contracts": patch
---

The browser wait action now tells the model its limit: timeoutMs is described as up to 120000 ms (2 minutes), with a default of 30000, and says to wait again for longer waits such as a person approving a sign-in on their phone. The shown tool schema drops large numeric bounds, so the limit was invisible and agents found it only by being refused.
