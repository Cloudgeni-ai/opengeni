---
"@opengeni/api-router": patch
---

`startApi` accepts a `sessionAuthorization` option, so an embedding host that runs the packaged API entry instead of mounting `createApp(deps)` can bind its `SessionAuthorizationPort`. Unset keeps standalone startup unchanged. Contributed by Ali Ozaltin (Botel AI) in #2539.
