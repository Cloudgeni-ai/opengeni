---
"@opengeni/api-router": patch
---

Adding a second account of a service such as Linear no longer fails with "Reconnect your existing account once, then add another" just because the service was slow to say which account the first login belonged to. The account check is tried once more when it times out or fails briefly, and before a new account is refused, the person's earlier logins whose account was never confirmed are checked again with their own saved sign-in. If an earlier login still can't be confirmed, the refusal stays as before.
