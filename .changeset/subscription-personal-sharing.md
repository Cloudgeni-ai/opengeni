---
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Let a personal subscription account's owner, when also an organization administrator,
explicitly share that account through the existing access editor. The form explains
consumer-plan limits and requires a chosen workspace reach before sharing. Other
administrators cannot discover or convert someone else's personal account.

Migration 0745 adds the owner- and version-fenced transition. The connection identity,
encrypted credentials, quota, pins and accepted history stay intact. Old personal
resource authority is revoked, never reinterpreted as shared authority. Conversion
and the requested reach commit together; stale versions, conflicting upstream
identities and invalid reach leave the personal account unchanged.
