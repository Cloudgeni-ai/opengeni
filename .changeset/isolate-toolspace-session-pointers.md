---
"@opengeni/runtime": minor
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Route Toolspace token seeding, renewal, agent commands, and Channel-A terminal
commands through deterministic per-session files when several sessions share a
sandbox group. Preserve the box manifest's stable legacy pointer for warm-box
compatibility, remove any legacy bearer during seeding, and prevent the
group-global ttyd process from inheriting session-bound Toolspace authority.
