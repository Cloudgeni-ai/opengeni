---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Add the managed-human organization invitation, role, suspension, offboarding,
and retention lifecycle with revision-fenced APIs and SDK methods. Self
invitation history is exposed only through bounded keyset pages, and acceptance
resolves one exact subject-bound invitation. Already-open session,
workspace-control, live, and interaction streams periodically recheck current
membership authority and close after revocation. A bounded operator command
commits expired offboarded personal database deletion together with a closed,
exact-key cleanup-obligation set before deleting external objects. Provider
failures retry only unfinished obligations, retained references abort before
external bytes are touched, and immutable lifecycle evidence survives cleanup.
