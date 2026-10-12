---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Choosing a session's model account is now classified internally as the provider-neutral `session.model_account.write` operation, for the neutral `PUT .../model-account` route and the older Codex pin route alike. Hosts receive the older name `session.codex_account.write` by default, preserving existing allow/deny policies. After migrating policy keys, hosts opt in to neutral delivery with `SessionAuthorizationPort.capabilities.modelAccountOperation: true`. Both names remain valid; `canonicalSessionAuthorizationOperation` and `SESSION_AUTHORIZATION_OPERATION_ALIASES` normalize old names, but input normalization alone does not migrate policy keys. Each authorization calls the host once, never retrying a denial under another alias. Turning a person's personal-fallback opt-in on now wakes only that person's own waiting turns instead of every waiting turn in the organization, because no other session can place on their personal accounts.
