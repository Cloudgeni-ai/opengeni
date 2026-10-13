---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Preserve per-person fallback consent during the Claude and SuperGrok cutovers.
Existing warm automatic personal bindings survive a fallback opt-out until
re-selection, while live revocation still takes effect. Cross-provider recovery
counts refusals and serving changes together and reports a typed exhausted
failure at the bound. Unknown account catalogs no longer imply an entitlement
denial based on another account's plan.

Take the membership lifecycle fence before organization access reads so explicit
personal-account sharing cannot deadlock against management revocation. Cover
sharing, refresh and disconnect races without changing existing credentials,
pins, leases, quota, accepted authority or history.
