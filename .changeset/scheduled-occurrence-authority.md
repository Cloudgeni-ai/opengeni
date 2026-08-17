---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Make every accepted scheduled agent occurrence an immutable, credential-free
execution snapshot bound to one run, session, scheduled update, logical turn,
and attempt chain. Agent tasks accept explicit `connectionAuthorities`
(omitted preserves, `[]` clears, an array replaces), execution-affecting edits
require the same causal human, `once` grants are consumed exactly once per
run, cold reusable sessions converge on one revision-bound materialization
receipt, and task deletion becomes a one-way paused tombstone with durable
connector cleanup. Create/update requests are byte-bounded at ingress while
stored rows stay readable. Migration `0275` is a maintenance cutover.
