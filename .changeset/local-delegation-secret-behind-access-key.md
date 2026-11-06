---
"@opengeni/config": patch
---

A local-mode deployment that turns on the shared access key (`OPENGENI_AUTH_REQUIRED=true` with `OPENGENI_ACCESS_KEY`) no longer signs or accepts first-party delegated bearers with the built-in local delegation secret. It uses `OPENGENI_DELEGATION_SECRET` when set and otherwise derives the secret from the access key, as configured mode already does. The built-in secret remains only for local deployments without the access-key perimeter.
