---
"@opengeni/contracts": minor
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Choosing a session's model account is now authorized as the provider-neutral `session.model_account.write` operation, for the neutral `PUT .../model-account` route and the older Codex pin route alike. The older name `session.codex_account.write` stays a valid `SessionAuthorizationOperation` value, so hosts written against it keep compiling, but Opengeni no longer sends it; `canonicalSessionAuthorizationOperation` and `SESSION_AUTHORIZATION_OPERATION_ALIASES` normalize it. Turning a person's personal-fallback opt-in on now wakes only that person's own waiting turns instead of every waiting turn in the organization, because no other session can place on their personal accounts.
