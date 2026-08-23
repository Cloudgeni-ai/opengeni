---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/db": minor
---

Bound and shape the durable text an agent authors on a user's behalf. The budget
follows the destination, on every agent surface that reaches it. A mandatory
workspace rule is composed verbatim into the prompt of every session it applies
to, so `remember`, `instruction_policy_propose`, and `task_note_promote_instruction_policy`
are all capped at 600 characters; the preference destination is capped at 1,200
across its three surfaces, because only its short descriptor is composed and the
content is retrieved on demand. Task-note promotion is checked in the database
layer, where the content is the note rather than a request field, and is rejected
rather than truncated before any evidence, claim, or proposal row is written.
`company_profile_propose`, the largest always-on surface, is capped for agents at
400 characters per scalar, 200 per list entry, and 4,096 UTF-8 bytes total. The
Knowledge lane keeps its 4,000-character retrieval-evidence ceiling, and every
human editor limit is unchanged so nothing a person already typed becomes
invalid. Tool descriptions now state the prompt cost and the authoring shape, and
the `remember` confirmation card names the character count and destination so a
human can judge the cost before saving. Existing stored revisions are never
rewritten.
