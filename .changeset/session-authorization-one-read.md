---
"@opengeni/db": patch
"@opengeni/core": patch
---

Session authorization reads everything it needs in one database round trip. Authorizing an agent's action on its own session used to make five sequential scoped reads (Slack ownership, the session's authority, the full caller session with its event cursor and connector metadata, the live attempt's turn with its goal snapshot, and the target identity), about 37 statements. One scoped statement now returns the target's authority and Slack ownership together with the caller session and its live attempt turn, so the check is BEGIN, setup, read and COMMIT. Every fact comes from the same snapshot and the same RLS visibility, and every denial (missing or hidden target, stale or forged attempt, ended attempt, revoked linked authority, Slack-private ownership, private sessions, cross-tree reach and host decisions) is decided exactly as before.
