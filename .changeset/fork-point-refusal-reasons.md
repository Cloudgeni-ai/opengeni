---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Forking a chat at a message that cannot be a fork point now says why, instead of the generic "Invalid session tenancy request". The fork routine's four boundary refusals (not a user or agent message, the message's history was superseded by compaction, the history up to it was compacted, or it splits an unfinished tool exchange) reach `SessionTenancyInvalidRequestError.forkPointRefusal`. The API returns them as 422 `validation_failed` with `details.reason` `fork_point_<reason>`, and the fork dialog explains each one. Other invalid requests keep the generic error.
