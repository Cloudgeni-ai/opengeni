---
"@opengeni/db": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

The session list can show only your workstreams. `mineOnly=true` (with `view=page`; SDK `listSessionPage`/`listSessionSummaryPage` `mineOnly`, React `useWorkspaceSessions` `mineOnly`) keeps a workstream when any session in its tree was created by you or received a message you sent directly; agent-relayed messages and service turns do not count. Matching roots list their children in full, totals follow the filter, and the response echoes `mineOnly: true`. The web sidebar's view menu adds an "Only mine" option. A new online index (`session_turns_human_prompt_subject_idx`, built concurrently in rolling migration 0799) keeps the probe to one index lookup per tree session.
