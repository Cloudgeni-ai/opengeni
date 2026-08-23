---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

Bound and shape the durable text an agent authors on a user's behalf. A mandatory
workspace rule is composed verbatim into the prompt of every session in the
workspace, so agent authoring of one is now capped at 600 characters and an
agent-authored preference at 1,200, with actionable rejection messages that name
the actual length, the limit, and the shape to use instead. The Knowledge lane
keeps its 4,000-character retrieval-evidence ceiling, and the human editor limits
are unchanged so nothing a person already typed becomes invalid. The `remember`,
`instruction_policy_propose`, `preference_propose`, task-note promotion, and
`company_profile_propose` tool descriptions now state the prompt cost and the
authoring shape, and the `remember` confirmation card names the character count
and where the text lands so a human can judge the cost before saving. Existing
stored revisions are never rewritten.
