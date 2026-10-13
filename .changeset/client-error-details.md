---
"@opengeni/contracts": patch
"@opengeni/observability": patch
"@opengeni/api-router": patch
---

Web client error reports now say why a page failed, not only where: the beacon carries the error's name, message and stack, plus React's component stack for a render failure. The browser and the API apply one shared projection that removes URL query strings, redacts obvious credentials and bounds each field, and the API logs the result as `clientErrorName`, `clientErrorMessage`, `clientErrorStack` and `clientComponentStack` on the `Web client error reported` line.
